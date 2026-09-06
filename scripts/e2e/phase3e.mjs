import { chromium } from '@playwright/test';
import { mkdirSync, appendFileSync } from 'node:fs';
import { waitUntil, sleep } from './lib.mjs';

const PORT = process.env.FORGE_PORT;
const RUN = 'probe-e2e-4-kill';
const SHOT_DIR = process.env.SHOT_DIR;
const TRANSCRIPT = process.env.TRANSCRIPT;
mkdirSync(SHOT_DIR, { recursive: true });

function log(...args) {
  const line = `[phase3e ${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  if (TRANSCRIPT) appendFileSync(TRANSCRIPT, line + '\n');
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  let threadFetches = 0;
  page.on('request', (req) => {
    if (req.url().includes('/thread')) { threadFetches += 1; log('GET/POST', req.url()); }
  });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  const tileSel = `[data-testid="lane-${RUN}"]`;
  await page.waitForSelector(tileSel, { timeout: 30000 });
  log('attached, state:', await page.getAttribute(tileSel, 'data-state'));

  await page.locator(tileSel).click();
  await page.waitForSelector('[data-testid="ticket-sheet"]', { timeout: 10000 });
  const killBtn = page.locator('[data-testid="ticket-sheet"]').getByText('Kill', { exact: true });
  await killBtn.click();
  const clickAt = Date.now();
  log('clicked Kill at', clickAt, 'thread fetches so far:', threadFetches);

  // race the confirm click against the board's own refresh cycle
  let confirmed = false;
  for (let attempt = 0; attempt < 40 && !confirmed; attempt += 1) {
    const has = await page.locator('[data-testid="rail-thread"]').getByText('Confirm', { exact: true }).count();
    if (has > 0) {
      await page.locator('[data-testid="rail-thread"]').getByText('Confirm', { exact: true }).click();
      confirmed = true;
      log('clicked Confirm', Date.now() - clickAt, 'ms after Kill; thread fetches in between:', threadFetches);
      break;
    }
    await sleep(50);
  }
  if (!confirmed) {
    log('NEVER SAW A CONFIRM CARD -- the ephemeral card was gone before this loop ever found it. thread fetches so far:', threadFetches);
    await page.screenshot({ path: `${SHOT_DIR}/no-confirm-card.png`, fullPage: true });
    process.exit(3);
  }

  await sleep(3000);
  await page.screenshot({ path: `${SHOT_DIR}/after-confirm.png`, fullPage: true });
  await waitUntil(async () => {
    const state = await page.getAttribute(tileSel, 'data-state').catch(() => null);
    return state === 'killed';
  }, { timeoutMs: 20000, label: 'tile shows killed' });
  log('tile shows killed');
  await page.screenshot({ path: `${SHOT_DIR}/killed.png`, fullPage: true });

  await browser.close();
  log('phase3e driver done');
}

main().catch((err) => {
  console.error('PHASE3E FAILED', err);
  if (TRANSCRIPT) appendFileSync(TRANSCRIPT, `PHASE3E FAILED ${err}\n`);
  process.exit(1);
});

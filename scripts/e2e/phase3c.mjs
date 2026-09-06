import { chromium } from '@playwright/test';
import { mkdirSync, appendFileSync } from 'node:fs';
import { waitUntil, sleep } from './lib.mjs';

const PORT = process.env.FORGE_PORT;
const RUN = 'probe-e2e-4-kill';
const SHOT_DIR = process.env.SHOT_DIR;
const TRANSCRIPT = process.env.TRANSCRIPT;
mkdirSync(SHOT_DIR, { recursive: true });

function log(...args) {
  const line = `[phase3c ${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  if (TRANSCRIPT) appendFileSync(TRANSCRIPT, line + '\n');
}
async function shot(page, name) {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  const tileSel = `[data-testid="lane-${RUN}"]`;
  await page.waitForSelector(tileSel, { timeout: 30000 });
  log('attached, state:', await page.getAttribute(tileSel, 'data-state'));

  await page.locator(tileSel).click();
  await page.waitForSelector('[data-testid="ticket-sheet"]', { timeout: 10000 });
  await shot(page, '00-sheet-open');
  const killBtn = page.locator('[data-testid="ticket-sheet"]').getByText('Kill', { exact: true });
  await killBtn.waitFor({ state: 'visible', timeout: 10000 });
  await killBtn.click({ force: true });
  log('clicked Kill');

  // poll for the confirm card rather than assuming a fixed delay
  await waitUntil(async () => {
    const text = await page.locator('[data-testid="rail-thread"]').innerText().catch(() => '');
    return text.includes('Confirm — irreversible');
  }, { timeoutMs: 15000, intervalMs: 500, label: 'confirm card appears in rail' });
  log('confirm card visible');
  await shot(page, '01-confirm-card');

  await page.locator('[data-testid="rail-thread"]').getByText('Confirm', { exact: true }).click({ force: true });
  log('clicked Confirm');
  await sleep(3000);
  await shot(page, '02-after-confirm');

  await waitUntil(async () => {
    const state = await page.getAttribute(tileSel, 'data-state').catch(() => null);
    return state === 'killed';
  }, { timeoutMs: 20000, label: 'tile shows killed' });
  log('tile shows killed');
  await shot(page, '03-killed');

  await browser.close();
  log('phase3c driver done');
}

main().catch((err) => {
  console.error('PHASE3C FAILED', err);
  if (TRANSCRIPT) appendFileSync(TRANSCRIPT, `PHASE3C FAILED ${err}\n`);
  process.exit(1);
});

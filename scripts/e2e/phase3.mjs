import { chromium } from '@playwright/test';
import { mkdirSync, appendFileSync } from 'node:fs';
import { waitUntil, sleep } from './lib.mjs';

const PORT = process.env.FORGE_PORT;
const RUN = 'probe-e2e-4-kill';
const SHOT_DIR = process.env.SHOT_DIR;
const TRANSCRIPT = process.env.TRANSCRIPT;
mkdirSync(SHOT_DIR, { recursive: true });

function log(...args) {
  const line = `[phase3 ${new Date().toISOString()}] ${args.join(' ')}`;
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
  await shot(page, '01-run3-running');

  await sleep(8000); // let it accrue some real progress first

  await page.locator(tileSel).click();
  await page.waitForSelector('[data-testid="ticket-sheet"]', { timeout: 10000 });
  await page.locator('[data-testid="ticket-sheet"]').getByText('Kill', { exact: true }).click();
  log('clicked Kill');
  await sleep(500);
  await shot(page, '02-run3-confirm-card');
  // the kill is behind a confirm card in the rail
  await page.locator('[data-testid="rail-thread"]').getByText('Confirm', { exact: true }).click();
  log('clicked Confirm');
  await sleep(3000);
  await shot(page, '03-run3-after-confirm');

  await waitUntil(async () => {
    const state = await page.getAttribute(tileSel, 'data-state').catch(() => null);
    return state === 'killed';
  }, { timeoutMs: 20000, label: 'tile shows killed' });
  log('tile shows killed');
  await shot(page, '04-run3-killed');

  await browser.close();
  log('phase3 driver done');
}

main().catch((err) => {
  console.error('PHASE3 FAILED', err);
  if (TRANSCRIPT) appendFileSync(TRANSCRIPT, `PHASE3 FAILED ${err}\n`);
  process.exit(1);
});

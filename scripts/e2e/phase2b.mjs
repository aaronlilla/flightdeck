import { chromium } from '@playwright/test';
import { mkdirSync, appendFileSync } from 'node:fs';
import { waitUntil, sleep } from './lib.mjs';

const HOME = process.env.FORGE_HOME;
const PORT = process.env.FORGE_PORT;
const RUN = 'probe-e2e-2-pause';
const SHOT_DIR = process.env.SHOT_DIR;
const TRANSCRIPT = process.env.TRANSCRIPT;
mkdirSync(SHOT_DIR, { recursive: true });

function log(...args) {
  const line = `[phase2b ${new Date().toISOString()}] ${args.join(' ')}`;
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
  await page.waitForSelector(tileSel, { timeout: 15000 });
  log('attached, current state', await page.getAttribute(tileSel, 'data-state'));

  await page.locator(tileSel).click();
  await page.waitForSelector('[data-testid="ticket-sheet"]', { timeout: 10000 });
  await page.locator('[data-testid="ticket-sheet"]').getByText('Pause', { exact: true }).click();
  log('clicked Pause');
  await sleep(2000);
  await page.keyboard.press('Escape');
  await shot(page, '03-run2-paused-clicked');

  await waitUntil(async () => {
    const state = await page.getAttribute(tileSel, 'data-state').catch(() => null);
    return state === 'paused';
  }, { timeoutMs: 20000, label: 'tile shows paused' });
  log('tile shows paused');
  await shot(page, '04-run2-paused-confirmed');

  await page.locator(tileSel).click();
  await page.waitForSelector('[data-testid="ticket-sheet"]', { timeout: 10000 });
  const resumeBtn = page.locator('[data-testid="ticket-sheet"]').getByText(/^Resume/, { exact: false });
  await resumeBtn.click();
  log('clicked Resume');
  await sleep(2000);
  await page.keyboard.press('Escape');
  await waitUntil(async () => {
    const state = await page.getAttribute(tileSel, 'data-state').catch(() => null);
    return state === 'running';
  }, { timeoutMs: 30000, label: 'tile back to running after resume' });
  log('tile running again after resume');
  await shot(page, '05-run2-resumed');

  await browser.close();
  log('phase2b driver done');
}

main().catch((err) => {
  console.error('PHASE2B FAILED', err);
  if (TRANSCRIPT) appendFileSync(TRANSCRIPT, `PHASE2B FAILED ${err}\n`);
  process.exit(1);
});

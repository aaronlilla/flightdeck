import { chromium } from '@playwright/test';
import { mkdirSync, appendFileSync } from 'node:fs';
import { waitUntil, sleep } from './lib.mjs';

const PORT = process.env.FORGE_PORT;
const SHOT_DIR = process.env.SHOT_DIR;
const TRANSCRIPT = process.env.TRANSCRIPT;
mkdirSync(SHOT_DIR, { recursive: true });

function log(...args) {
  const line = `[phase4 ${new Date().toISOString()}] ${args.join(' ')}`;
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
  await page.waitForSelector('[data-testid="rail-thread"]', { timeout: 15000 });
  log('board open, feed live');
  await shot(page, '01-live');

  console.log('SIGNAL: stop the server now');
  // wait here for the coordinator process to actually kill the server, signalled by
  // the /lanes fetch starting to fail from inside the page itself
  await waitUntil(async () => {
    const bannerVisible = await page.getByText(/live feed lost/).count();
    return bannerVisible > 0;
  }, { timeoutMs: 60000, intervalMs: 1000, label: 'disconnected banner appears' });
  log('disconnected banner appeared');
  await shot(page, '02-disconnected-banner');

  const bannerText = await page.getByText(/live feed lost/).innerText();
  log('banner text:', bannerText);

  const composerDisabledText = await page.locator('text=Composer disabled').innerText().catch(() => null);
  log('composer disabled text:', composerDisabledText);
  await shot(page, '03-composer-disabled');

  console.log('SIGNAL: restart the server now');
  await waitUntil(async () => {
    const bannerVisible = await page.getByText(/live feed lost/).count();
    return bannerVisible === 0;
  }, { timeoutMs: 60000, intervalMs: 1000, label: 'banner clears after restart' });
  log('banner cleared, feed recovered');
  await shot(page, '04-recovered');

  await browser.close();
  log('phase4 driver done');
}

main().catch((err) => {
  console.error('PHASE4 FAILED', err);
  if (TRANSCRIPT) appendFileSync(TRANSCRIPT, `PHASE4 FAILED ${err}\n`);
  process.exit(1);
});

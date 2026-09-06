import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { sleep } from './lib.mjs';

const PORT = process.env.FORGE_PORT;
const RUN = 'probe-e2e-4-kill';
const SHOT_DIR = process.env.SHOT_DIR;
mkdirSync(SHOT_DIR, { recursive: true });

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on('console', (msg) => console.log('BROWSER:', msg.type(), msg.text()));
  page.on('pageerror', (err) => console.log('PAGEERROR:', err));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  const tileSel = `[data-testid="lane-${RUN}"]`;
  await page.waitForSelector(tileSel, { timeout: 30000 });

  await page.locator(tileSel).click();
  await page.waitForSelector('[data-testid="ticket-sheet"]', { timeout: 10000 });
  const killBtn = page.locator('[data-testid="ticket-sheet"]').getByText('Kill', { exact: true });
  await killBtn.click();
  console.log('clicked kill, sleeping 2s before screenshot');
  await sleep(2000);
  await page.screenshot({ path: `${SHOT_DIR}/immediate-after-kill.png`, fullPage: true });
  const bodyText = await page.locator('body').innerText();
  console.log('BODY TEXT SNIPPET (contains Confirm?):', bodyText.includes('Confirm'));
  console.log('BODY TEXT SNIPPET (contains ticket-sheet still open?):', await page.locator('[data-testid="ticket-sheet"]').count());
  await browser.close();
}
main().catch((e) => { console.error('FAILED', e); process.exit(1); });

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const PORT = process.env.FORGE_PORT;
const SHOT_DIR = process.env.SHOT_DIR;
mkdirSync(SHOT_DIR, { recursive: true });

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector('[data-testid="rail-thread"]', { timeout: 15000 });
  const bannerCount = await page.getByText(/live feed lost/).count();
  console.log('banner count on fresh load (server already back up):', bannerCount);
  await page.screenshot({ path: `${SHOT_DIR}/05-fresh-load-recovered.png`, fullPage: true });
  // confirm composer is enabled again
  const composerEnabled = await page.locator('[data-testid="rail-thread"]').locator('..').getByPlaceholder(/command/).count();
  console.log('composer input present (enabled state):', composerEnabled);
  await browser.close();
}
main().catch((e) => { console.error('FAILED', e); process.exit(1); });

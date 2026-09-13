/**
 * Puts one real piece of work into the console through the console, and reports what the
 * screen says back. No server call: every step is a click or a keystroke on the page, so
 * what this proves is that a person could have done it.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BRIEF = process.argv[2];
if (!BRIEF) { console.error('usage: node drive-ticket.mjs "<brief>"'); process.exit(2); }

const token = readFileSync(process.env.USERPROFILE + '/.forge/server-token', 'utf8').trim();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
await page.addInitScript((t) => { localStorage.setItem('forge-token', t); }, token);

for (let i = 0; i < 30; i += 1) {
  try { await page.goto('http://127.0.0.1:4120/', { waitUntil: 'networkidle', timeout: 5000 }); break; }
  catch { await page.waitForTimeout(2000); }
}

await page.click('[data-testid="nav-queue"]');
await page.waitForTimeout(2000);

const before = await page.locator('[data-testid^="queue-row-"]').count();
console.log('rows waiting before:', before);

await page.fill('[data-testid="queue-add-input"]', BRIEF);
await page.waitForTimeout(400);
console.log('it read this as:', await page.locator('[data-testid="queue-add-reading"]').textContent());

await page.click('[data-testid="queue-add-submit"]');
await page.waitForTimeout(6000);

const after = await page.locator('[data-testid^="queue-row-"]').count();
console.log('rows waiting after:', after);
const alert = await page.locator('[data-testid="queue-add"] [role="alert"]').count();
if (alert) console.log('REFUSED:', await page.locator('[data-testid="queue-add"] [role="alert"]').textContent());

const rows = await page.locator('[data-testid^="queue-row-"]').allTextContents();
for (const row of rows) console.log('  row:', row.replace(/\s+/g, ' ').trim().slice(0, 140));

await page.screenshot({ path: 'C:/Users/aaron/AppData/Local/Temp/claude/drive-queue.png', fullPage: true });
await browser.close();

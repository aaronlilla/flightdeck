import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const token = readFileSync(process.env.USERPROFILE + '/.forge/server-token', 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1100 } });
await p.addInitScript((t) => { localStorage.setItem('forge-token', t); }, token);
for (let i = 0; i < 60; i += 1) {
  try { await p.goto('http://127.0.0.1:4120/', { waitUntil: 'domcontentloaded', timeout: 5000 }); break; }
  catch { await sleep(2000); }
}
await p.waitForTimeout(12000);

async function mergeButtons() {
  const out = [];
  for (const el of await p.locator('button').all()) {
    const t = (await el.textContent().catch(() => ''))?.trim() ?? '';
    if (/^(Merge|Confirm merge|Merging…)$/i.test(t)) out.push([el, t]);
  }
  return out;
}
let btns = await mergeButtons();
console.log('merge controls:', btns.map(([, t]) => t).join(', ') || 'none');
if (!btns.length) { console.log('no merge control on the board'); await b.close(); process.exit(0); }
const [btn] = btns[btns.length - 1];
const t0 = Date.now();
await btn.click();
let felt = 'none in 3s';
for (let i = 0; i < 60; i += 1) {
  const l = (await btn.textContent().catch(() => null));
  if (l === null) { felt = `${Date.now() - t0}ms -> the row left the screen`; break; }
  if (l.trim() !== 'Merge') { felt = `${Date.now() - t0}ms -> "${l.trim()}"`; break; }
  await p.waitForTimeout(50);
}
console.log('feedback:', felt);
// The confirm may be in place on the button, or on a card in the rail.
await p.waitForTimeout(2500);
const label = (await btn.textContent().catch(() => ''))?.trim() ?? '';
console.log('button now:', label || '(gone)');
if (/confirm/i.test(label)) { await btn.click(); console.log('pressed Confirm in place'); }
else {
  const c = p.locator('button', { hasText: /^Confirm$/ }).first();
  if (await c.count()) { await c.click(); console.log('pressed Confirm on the card'); }
  else console.log('NO CONFIRM CONTROL ANYWHERE -- the click has nowhere to go');
}
await p.waitForTimeout(45000);
await p.screenshot({ path: 'merged.png' });
console.log('done');
await b.close();

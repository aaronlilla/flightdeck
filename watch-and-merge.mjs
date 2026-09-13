import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const T = readFileSync(process.env.USERPROFILE + '/.forge/server-token', 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = '';
let ready = null;
for (let i = 0; i < 110; i += 1) {
  try {
    const r = await fetch('http://127.0.0.1:4120/queue', { headers: { 'X-Forge-Token': T } });
    const d = await r.json();
    const counts = {};
    for (const x of d.items) counts[x.state] = (counts[x.state] ?? 0) + 1;
    const line = JSON.stringify(counts);
    if (line !== last) { console.log(new Date().toTimeString().slice(0, 8), line); last = line; }
    const hit = d.items.find((x) => x.state === 'review' && x.pr && !x.pr.merged && !x.pr.closed);
    if (hit) { ready = hit; console.log('READY:', hit.ticket, 'PR#' + hit.pr.no); break; }
  } catch { /* restarting */ }
  await sleep(30000);
}
if (!ready) { console.log('nothing became ready to merge in 55 minutes'); process.exit(0); }

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1100 } });
await p.addInitScript((t) => { localStorage.setItem('forge-token', t); }, T);
await p.goto('http://127.0.0.1:4120/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(14000);
const buttons = [];
for (const el of await p.locator('button').all()) {
  const t = (await el.textContent().catch(() => ''))?.trim() ?? '';
  if (t === 'Merge') buttons.push(el);
}
console.log('merge controls on screen:', buttons.length);
if (buttons.length) {
  const btn = buttons[buttons.length - 1];
  const t0 = Date.now();
  await btn.click();
  let felt = 'none in 3s';
  for (let i = 0; i < 60; i += 1) {
    const l = await btn.textContent().catch(() => null);
    if (l === null) { felt = `${Date.now() - t0}ms -> row left the screen`; break; }
    if (l.trim() !== 'Merge') { felt = `${Date.now() - t0}ms -> "${l.trim()}"`; break; }
    await p.waitForTimeout(50);
  }
  console.log('Merge feedback:', felt);
  await p.waitForTimeout(2500);
  const label = (await btn.textContent().catch(() => ''))?.trim() ?? '';
  if (/confirm/i.test(label)) { await btn.click(); console.log('confirmed on the button'); }
  else {
    const c = p.locator('button', { hasText: /^Confirm$/ }).first();
    if (await c.count()) { await c.click(); console.log('confirmed on the card'); }
    else console.log('NO CONFIRM CONTROL');
  }
  await p.waitForTimeout(50000);
  console.log('done; check the pull request state');
}
await b.close();

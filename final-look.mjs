import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const token = readFileSync(process.env.USERPROFILE + '/.forge/server-token', 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1100 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
await p.addInitScript((t) => { localStorage.setItem('forge-token', t); }, token);
for (let i = 0; i < 60; i += 1) {
  try { await p.goto('http://127.0.0.1:4120/', { waitUntil: 'domcontentloaded', timeout: 5000 }); break; }
  catch { await sleep(2000); }
}
await p.waitForTimeout(16000);
const text = ((await p.locator('body').textContent()) ?? '').replace(/\s+/g, ' ');
const probes = ['nothing is in the queue', 'never synced', 'Title not read yet', 'drift confirmed off-brief', 'transcript tail'];
for (const probe of probes) console.log((text.includes(probe) ? 'STILL THERE: ' : 'gone:        ') + probe);
for (const re of [/It stopped [^.]*\./, /Waiting for a Ready ticket;[^.]*\./, /THIS MACHINE|THE BOARD [a-z ]{0,24}/]) {
  const m = text.match(re);
  console.log('reads:', m ? m[0].trim().slice(0, 120) : '(not on this screen)');
}
console.log('page errors:', errs.length ? errs.slice(0, 2).join(' || ') : 'none');
await p.screenshot({ path: 'board-final2.png' });
await b.close();

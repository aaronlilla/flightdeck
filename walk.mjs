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
await p.waitForTimeout(15000);
const strip = p.locator('[data-testid="needs-you"], .needs-you').first();
for (let step = 0; step < 14; step += 1) {
  const t = ((await strip.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ');
  console.log(`${step}:`, t.slice(0, 150));
  const next = p.locator('button, a').filter({ hasText: /^Next$/ }).first();
  if (!(await next.count()) || !(await next.isEnabled().catch(() => false))) break;
  await next.click().catch(() => undefined);
  await p.waitForTimeout(800);
}
await b.close();

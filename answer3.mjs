import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const token = readFileSync(process.env.USERPROFILE + '/.forge/server-token', 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ANSWERS = [
  [/400 from AccountManagementController/i, 'It carries a reason. Both refusals throw ProblemDetailsException with a written message and a 400: "Cannot increase daily limit while limit is active. Current limit: X, Requested: Y" and "Cannot shorten duration while limit is active. Current end date: ..., New end date would be: ...". Show the server message; do not invent client copy.'],
  [/know which call failed/i, 'No, and the gap strands money. CmsPlayerController.cs:816-823 calls WithdrawCwaFundsAsync then CreateCashoutVoucherAsync with no try/catch, no transaction and no compensating action, so a throw in the voucher call carries nothing saying the debit already succeeded. Treat any 4xx or 5xx after the debit as money-may-have-moved until the backend marks which call failed.'],
  [/one-off local Gradle build|internal-distribution profile/i, 'Add the internal-distribution profile. A one-off hand build is a keystore question every time it is asked, and this is the second time; the profile makes the next one a command.'],
];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1100 } });
await p.addInitScript((t) => { localStorage.setItem('forge-token', t); }, token);
for (let i = 0; i < 60; i += 1) {
  try { await p.goto('http://127.0.0.1:4120/', { waitUntil: 'domcontentloaded', timeout: 5000 }); break; }
  catch { await sleep(2000); }
}
await p.waitForTimeout(15000);
const strip = p.locator('[data-testid="needs-you"], .needs-you').first();
let answered = 0;
for (let step = 0; step < 16; step += 1) {
  const text = ((await strip.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ');
  const hit = ANSWERS.find(([re]) => re.test(text));
  if (hit) {
    const box = p.locator('input[placeholder="Other…"], textarea[placeholder="Other…"]').first();
    await box.fill(hit[1]);
    const t0 = Date.now();
    await p.locator('button', { hasText: /^Answer$/ }).first().click();
    for (let i = 0; i < 60; i += 1) {
      const now = ((await strip.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ');
      if (now !== text) { console.log(`answered in ${Date.now() - t0}ms:`, text.slice(40, 110)); break; }
      await p.waitForTimeout(50);
    }
    answered += 1;
    await p.waitForTimeout(2500);
    continue;
  }
  const next = p.locator('button, a').filter({ hasText: /^Next$/ }).first();
  if (!(await next.count()) || !(await next.isEnabled().catch(() => false))) {
    console.log('no further card to walk to at step', step);
    break;
  }
  await next.click().catch(() => undefined);
  await p.waitForTimeout(900);
}
console.log('answered', answered, 'of', ANSWERS.length);
await b.close();

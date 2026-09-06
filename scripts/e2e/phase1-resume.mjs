import { chromium } from '@playwright/test';
import { mkdirSync, appendFileSync } from 'node:fs';
import { readToken, waitUntil, sleep } from './lib.mjs';

const HOME = process.env.FORGE_HOME;
const PORT = process.env.FORGE_PORT;
const RUN = 'probe-e2e-1';
const SHOT_DIR = process.env.SHOT_DIR;
const TRANSCRIPT = process.env.TRANSCRIPT;
mkdirSync(SHOT_DIR, { recursive: true });

function log(...args) {
  const line = `[phase1-resume ${new Date().toISOString()}] ${args.join(' ')}`;
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
  log('board (re)opened, attaching to already-running', RUN);

  const tileSel = `[data-testid="lane-${RUN}"]`;
  await page.waitForSelector(tileSel, { timeout: 30000 });
  const stateNow = await page.getAttribute(tileSel, 'data-state');
  log('current tile state:', stateNow);
  await shot(page, '02b-attached-running');

  // wait for parked
  await waitUntil(async () => {
    const state = await page.getAttribute(tileSel, 'data-state').catch(() => null);
    return state === 'parked';
  }, { timeoutMs: 240000, label: 'tile parked (question raised)', intervalMs: 2000 });
  log('tile parked');
  await page.waitForSelector('text=Needs you', { timeout: 10000 });
  await shot(page, '04-needs-you-parked');
  const needsYouText = await page.locator('body').innerText();
  log('page text at parked (trimmed) length:', String(needsYouText.length));

  await page.waitForSelector('[data-testid="rail-thread"] >> text=Question', { timeout: 15000 });
  await shot(page, '05-rail-question');
  const railThreadText = await page.locator('[data-testid="rail-thread"]').innerText();
  log('rail thread text before answering:\n' + railThreadText);

  const yesBtn = page.locator('[data-testid="rail-thread"] span').filter({ hasText: /^Yes$/ }).first();
  await yesBtn.click();
  log('clicked Yes');
  await sleep(2500);
  await shot(page, '06-answered');
  const railThreadTextAfter = await page.locator('[data-testid="rail-thread"]').innerText();
  log('rail thread text after answering:\n' + railThreadTextAfter);

  await waitUntil(async () => {
    const state = await page.getAttribute(tileSel, 'data-state').catch(() => null);
    return state === 'running';
  }, { timeoutMs: 30000, label: 'tile back to running after answer' });
  log('tile running again after answer');
  await shot(page, '07-running-again');

  await page.locator(tileSel).click();
  await page.waitForSelector('[data-testid="ticket-sheet"]', { timeout: 10000 });
  await shot(page, '08-ticket-sheet-open');
  const msgText = `e2e-message-${Date.now()}`;
  await page.fill(`[data-testid="ticket-sheet"] input[placeholder^="message"]`, msgText);
  await page.locator('[data-testid="ticket-sheet"]').getByText('Send ⏎').click();
  log('sent message', msgText);
  await sleep(2500);
  await shot(page, '09-message-sent');
  const ticketThreadText = await page.locator('[data-testid="ticket-sheet"]').innerText();
  log('ticket sheet text after send:\n' + ticketThreadText);
  console.log(`PHASE1_MSG_TEXT=${msgText}`);
  await page.keyboard.press('Escape');

  await waitUntil(async () => {
    const state = await page.getAttribute(tileSel, 'data-state').catch(() => null);
    log('polling final state: ' + state);
    return state === 'finished' || state === 'handed-off';
  }, { timeoutMs: 180000, label: 'run reaches a terminal state', intervalMs: 3000 });
  const finalState = await page.getAttribute(tileSel, 'data-state');
  log('final tile state: ' + finalState);
  await shot(page, '10-finished');
  const finalTileText = await page.locator(tileSel).innerText();
  log('final tile text:\n' + finalTileText);

  await browser.close();
  log('done');
}

main().catch((err) => {
  console.error('PHASE1RESUME FAILED', err);
  if (TRANSCRIPT) appendFileSync(TRANSCRIPT, `PHASE1RESUME FAILED ${err}\n`);
  process.exit(1);
});

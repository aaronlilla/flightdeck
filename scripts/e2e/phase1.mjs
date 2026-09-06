import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readToken, waitUntil, sleep } from './lib.mjs';

const HOME = process.env.FORGE_HOME;
const PORT = process.env.FORGE_PORT;
const RUN = 'probe-e2e-1';
const SHOT_DIR = process.env.SHOT_DIR;
mkdirSync(SHOT_DIR, { recursive: true });

function log(...args) {
  console.log(`[phase1 ${new Date().toISOString()}]`, ...args);
}

async function shot(page, name) {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

async function main() {
  const token = readToken(HOME);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector('text=Needs you', { timeout: 15000 }).catch(() => {});
  log('board opened');
  await shot(page, '01-board-empty');

  log('launching run', RUN);
  const launch = spawn('bash', ['scripts/e2e/launch-run.sh'], {
    cwd: process.env.FORGE_REPO_DIR ?? process.cwd(),
    env: {
      ...process.env,
      RUN, BRIEF: 'scripts/e2e/probe-e2e-1.md', FORGE_HOME: HOME,
      L: 'C:/tmp/forge-e2e-logs', CEILING: '150000',
    },
    stdio: 'inherit',
  });

  // 1. tile appears, running, cost climbs, context grows
  const tileSel = `[data-testid="lane-${RUN}"]`;
  await page.waitForSelector(tileSel, { timeout: 60000 });
  log('tile appeared');
  await shot(page, '02-tile-appeared');

  const readCostCtx = async () => {
    const el = await page.$(tileSel);
    if (!el) return null;
    const text = await el.innerText();
    return text;
  };

  const t0 = await readCostCtx();
  log('tile text at appear:\n' + t0);
  await sleep(20000);
  const t1 = await readCostCtx();
  log('tile text +20s:\n' + t1);
  await shot(page, '03-tile-after-20s');

  // 2. wait for the parked question to surface in needs-you + rail
  await waitUntil(async () => {
    const state = await page.getAttribute(tileSel, 'data-state').catch(() => null);
    return state === 'parked';
  }, { timeoutMs: 120000, label: 'tile parked (question raised)' });
  log('tile parked');
  await page.waitForSelector('text=Needs you', { timeout: 10000 });
  await shot(page, '04-needs-you-parked');

  const needsYouText = await page.locator('text=Needs you').first().locator('..').locator('..').innerText().catch(() => '(could not read needs-you strip)');
  log('needs-you strip text:\n' + needsYouText);

  // open the rail question card and answer it
  await page.waitForSelector('[data-testid="rail-thread"] >> text=Question', { timeout: 15000 });
  await shot(page, '05-rail-question');
  const railThreadText = await page.locator('[data-testid="rail-thread"]').innerText();
  log('rail thread text before answering:\n' + railThreadText);

  // click "Yes" inside the question card
  await page.locator('[data-testid="rail-thread"] >> text=Question').first().scrollIntoViewIfNeeded();
  const yesBtn = page.locator('[data-testid="rail-thread"] button, [data-testid="rail-thread"] span').filter({ hasText: /^Yes$/ }).first();
  await yesBtn.click();
  log('clicked Yes');
  await sleep(2000);
  await shot(page, '06-answered');
  const railThreadTextAfter = await page.locator('[data-testid="rail-thread"]').innerText();
  log('rail thread text after answering:\n' + railThreadTextAfter);

  // confirm tile returns to running
  await waitUntil(async () => {
    const state = await page.getAttribute(tileSel, 'data-state').catch(() => null);
    return state === 'running';
  }, { timeoutMs: 30000, label: 'tile back to running after answer' });
  log('tile running again after answer');
  await shot(page, '07-running-again');

  // 3. send a message from the ticket sheet composer
  await page.locator(tileSel).click();
  await page.waitForSelector('[data-testid="ticket-sheet"]', { timeout: 10000 });
  await shot(page, '08-ticket-sheet-open');
  const msgText = `e2e-message-${Date.now()}`;
  await page.fill(`[data-testid="ticket-sheet"] input[placeholder^="message"]`, msgText);
  await page.locator('[data-testid="ticket-sheet"]').getByText('Send ⏎').click();
  log('sent message', msgText);
  await sleep(2000);
  await shot(page, '09-message-sent');
  const ticketThreadText = await page.locator('[data-testid="ticket-sheet"]').innerText();
  log('ticket sheet text after send:\n' + ticketThreadText);
  console.log(`PHASE1_MSG_TEXT=${msgText}`);
  await page.keyboard.press('Escape');

  // 4. let it finish
  await waitUntil(async () => {
    const state = await page.getAttribute(tileSel, 'data-state').catch(() => null);
    log('polling final state:', state);
    return state === 'finished' || state === 'handed-off';
  }, { timeoutMs: 90000, label: 'run reaches a terminal state' });
  const finalState = await page.getAttribute(tileSel, 'data-state');
  log('final tile state:', finalState);
  await shot(page, '10-finished');
  const finalTileText = await page.locator(tileSel).innerText();
  log('final tile text:\n' + finalTileText);

  await browser.close();
  log('done');
}

main().catch((err) => {
  console.error('PHASE1 FAILED', err);
  process.exit(1);
});

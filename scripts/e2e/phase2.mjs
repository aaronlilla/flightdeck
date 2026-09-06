import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { waitUntil, sleep } from './lib.mjs';

const HOME = process.env.FORGE_HOME;
const PORT = process.env.FORGE_PORT;
const RUN = 'probe-e2e-2-pause';
const SHOT_DIR = process.env.SHOT_DIR;
const TRANSCRIPT = process.env.TRANSCRIPT;
mkdirSync(SHOT_DIR, { recursive: true });

function log(...args) {
  const line = `[phase2 ${new Date().toISOString()}] ${args.join(' ')}`;
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
  log('board opened for phase2');

  spawn('bash', ['scripts/e2e/launch-run.sh'], {
    cwd: process.env.FORGE_REPO_DIR ?? process.cwd(),
    env: {
      ...process.env,
      RUN, BRIEF: 'scripts/e2e/probe-e2e-2-pause.md', FORGE_HOME: HOME,
      L: 'C:/tmp/forge-e2e-logs', CEILING: '150000',
    },
    stdio: 'inherit',
  });

  const tileSel = `[data-testid="lane-${RUN}"]`;
  await page.waitForSelector(tileSel, { timeout: 60000 });
  log('tile appeared for', RUN);
  await shot(page, '01-run2-appeared');

  // let it run a bit so there is real progress to observe stopping
  await sleep(20000);
  await shot(page, '02-run2-running-20s');

  // send a message from the ticket sheet composer, with a nonce we can find in the journal
  await page.locator(tileSel).click();
  await page.waitForSelector('[data-testid="ticket-sheet"]', { timeout: 10000 });
  const nonce = `E2E-NONCE-${Date.now()}`;
  await page.fill(`[data-testid="ticket-sheet"] input[placeholder^="message"]`, nonce);
  await page.locator('[data-testid="ticket-sheet"]').getByText('Send ⏎').click();
  log('sent nonce message', nonce);
  await sleep(1500);
  const sheetTextAfterSend = await page.locator('[data-testid="ticket-sheet"]').innerText();
  log('ticket sheet text right after send:\n' + sheetTextAfterSend);
  console.log(`PHASE2_NONCE=${nonce}`);
  await page.keyboard.press('Escape');

  // pause it from the board (the Pause control lives in the ticket sheet)
  await page.locator(tileSel).click();
  await page.waitForSelector('[data-testid="ticket-sheet"]', { timeout: 10000 });
  await page.locator('[data-testid="ticket-sheet"]').getByText('Pause', { exact: true }).click();
  log('clicked Pause');
  await sleep(2000);
  await page.keyboard.press('Escape');
  await shot(page, '03-run2-paused-clicked');

  await waitUntil(async () => {
    const state = await page.getAttribute(tileSel, 'data-state').catch(() => null);
    return state === 'paused';
  }, { timeoutMs: 20000, label: 'tile shows paused' });
  log('tile shows paused');
  await shot(page, '04-run2-paused-confirmed');

  // resume it
  await page.locator(tileSel).click();
  await page.waitForSelector('[data-testid="ticket-sheet"]', { timeout: 10000 });
  const resumeBtn = page.locator('[data-testid="ticket-sheet"]').getByText(/^Resume/, { exact: false });
  await resumeBtn.click();
  log('clicked Resume');
  await sleep(2000);
  await page.keyboard.press('Escape');
  await waitUntil(async () => {
    const state = await page.getAttribute(tileSel, 'data-state').catch(() => null);
    return state === 'running';
  }, { timeoutMs: 30000, label: 'tile back to running after resume' });
  log('tile running again after resume');
  await shot(page, '05-run2-resumed');

  await browser.close();
  log('phase2 driver done');
}

main().catch((err) => {
  console.error('PHASE2 FAILED', err);
  if (TRANSCRIPT) appendFileSync(TRANSCRIPT, `PHASE2 FAILED ${err}\n`);
  process.exit(1);
});

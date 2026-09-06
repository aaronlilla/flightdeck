// Live proof for the kill/merge confirm-card race fix (src/console/App.tsx): clicks
// Kill on a real, live run, waits for the run's own event traffic to trigger at least
// one board refresh while the confirm card is still unconfirmed (the exact window the
// bug lived in), then clicks Confirm and asserts the kill actually goes through.
import { chromium } from '@playwright/test';

const PORT = process.env.FORGE_PORT;
const RUN = process.env.RUN;
if (!PORT || !RUN) {
  console.error('usage: FORGE_PORT=<port> RUN=<run id> node confirm-race-proof.mjs');
  process.exit(2);
}

function log(...args) {
  console.log(`[confirm-race-proof ${new Date().toISOString()}]`, ...args);
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const tileSel = `[data-testid="lane-${RUN}"]`;
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector(tileSel, { timeout: 30000 });
  log('tile attached, state:', await page.getAttribute(tileSel, 'data-state'));

  await page.locator(tileSel).click();
  await page.waitForSelector('[data-testid="ticket-sheet"]', { timeout: 10000 });
  await page.locator('[data-testid="ticket-sheet"]').getByText('Kill', { exact: true }).click();
  log('clicked Kill');
  await page.waitForSelector('text=Confirm — irreversible', { timeout: 5000 });
  log('confirm card appeared');

  // Let the run's own live event traffic land while the card sits unconfirmed -- this
  // is the exact window the race lived in: App's onEvent handler refetches /thread on
  // every /events frame, and a live run pushes tool.start/tool.end several times a
  // minute. Before the fix, any one of those refetches silently replaced state.thread
  // with the server's fixed reply and the card vanished with no error.
  await page.waitForTimeout(8000);
  const stillThere = await page.getByText('Confirm — irreversible').count();
  log('confirm card still present after 8s of live event traffic:', stillThere > 0);
  if (stillThere === 0) {
    console.error('CONFIRM CARD WAS LOST -- the race is not fixed');
    process.exit(1);
  }

  await page.getByText('Confirm', { exact: true }).click();
  log('clicked Confirm');

  await page.waitForFunction(
    (sel) => document.querySelector(sel)?.getAttribute('data-state') === 'killed',
    tileSel,
    { timeout: 20000 },
  );
  log('tile reads killed -- the kill went through despite the live refresh window');

  await browser.close();
}

main().catch((err) => {
  console.error('CONFIRM RACE PROOF FAILED', err);
  process.exit(1);
});

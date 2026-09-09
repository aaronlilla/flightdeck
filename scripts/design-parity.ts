/**
 * Screenshot pairs for the R-16 design port: every artboard of
 * `doctrine/design/Flightdeck Console.dc.html` next to the running console showing the
 * same screen, in both themes.
 *
 *   npx tsx scripts/design-parity.ts            build the console, then shoot
 *   npx tsx scripts/design-parity.ts --no-build  reuse dist/console
 *   npx tsx scripts/design-parity.ts --boards=1a,1b  a subset of the artboards
 *
 * The console side is the built console served by the stub server on
 * `FORGE_E2E_PORT` (default 4121) with the `design-parity` fixture loaded. The design
 * side is the `.dc.html` file served over HTTP from the repo root, so `support.js` can
 * fetch its sibling imports, with each `.dv-card` flipped to the theme under test.
 * Output: `test-results/design-parity/<artboard>-<theme>-{console,design}.png` and a
 * `report.json` carrying the pixel difference of each pair, measured on a canvas in the
 * same browser. Exit code 1 when a pair could not be taken.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';

const ROOT = resolve(process.cwd());
const OUT = join(ROOT, 'test-results', 'design-parity');
const CONSOLE_PORT = Number(process.env['FORGE_E2E_PORT'] ?? 4121);
const DESIGN_PORT = CONSOLE_PORT + 1;
const TOKEN = 'parity-token';
const THEMES = ['dark', 'light'] as const;
type Theme = typeof THEMES[number];

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

/** The repo root over HTTP, with the design's `brand/` reference mapped to the real folder. */
function serveDesign(): Promise<Server> {
  const server = createServer((request, response) => {
    let path = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
    if (path.startsWith('/doctrine/design/brand/')) path = path.replace('/doctrine/design/brand/', '/brand/');
    const full = join(ROOT, path);
    if (!full.startsWith(ROOT) || !existsSync(full) || statSync(full).isDirectory()) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream' });
    response.end(readFileSync(full));
  });
  return new Promise((done) => server.listen(DESIGN_PORT, '127.0.0.1', () => done(server)));
}

interface Board { id: string; label: string; design: string }
const BOARDS: Board[] = [
  { id: '1a', label: 'board', design: 'Board' },
  { id: '1b', label: 'blockers', design: 'Blockers' },
  { id: '1c', label: 'queue', design: 'Queue' },
  { id: '1d', label: 'lane-sheet', design: 'Lane sheet' },
  { id: '1e', label: 'settings', design: 'Settings' },
  { id: '1f', label: 'flight-review', design: 'Flight review' },
  { id: '1g', label: 'rail', design: 'Conductor rail' },
  { id: '1h', label: 'dialog-question', design: 'Dialog question' },
  { id: '1i', label: 'dialog-confirm', design: 'Dialog confirm' },
  { id: '1j', label: 'dialog-blocker', design: 'Dialog blocker' },
  { id: '1k', label: 'dialog-decision', design: 'Dialog decision' },
  { id: '2a', label: 'flow-blocker', design: 'Rail blocker conversation' },
  { id: '2b', label: 'flow-confirm', design: 'Rail confirm conversation' },
  { id: '2c', label: 'flow-question', design: 'Rail question conversation' },
  { id: '2d', label: 'flow-decision', design: 'Rail decision conversation' },
];

async function designShots(browser: Browser, theme: Theme): Promise<Record<string, string>> {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const url = `http://127.0.0.1:${DESIGN_PORT}/doctrine/design/Flightdeck%20Console.dc.html`;
  console.log(`design: ${url} (${theme})`);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.dv-card[data-screen-label] main, .dv-card[data-screen-label] [role="dialog"]', { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((t) => { document.querySelectorAll('.dv-card[data-theme]').forEach((el) => { (el as HTMLElement).dataset['theme'] = t; }); }, theme);
  await page.waitForTimeout(400);
  const files: Record<string, string> = {};
  for (const board of BOARDS) {
    const card = page.locator(`.dv-opt[id="${board.id}"] .dv-card`);
    await card.scrollIntoViewIfNeeded();
    const file = join(OUT, `${board.id}-${board.label}-${theme}-design.png`);
    await card.screenshot({ path: file });
    files[board.id] = file;
  }
  await page.close();
  return files;
}

async function loadFixture(name: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${CONSOLE_PORT}/__test/fixture?name=${name}`, { method: 'POST' });
  if (!response.ok) throw new Error(`fixture ${name}: ${response.status}`);
}

async function openConsole(browser: Browser, theme: Theme): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((t) => { try { localStorage.setItem('fd.theme', t); } catch { /* no storage */ } }, theme);
  const page = await context.newPage();
  const url = `http://127.0.0.1:${CONSOLE_PORT}/`;
  console.log(`console: ${url} (${theme})`);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="lane-NWR-182"]', { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  return page;
}

async function send(page: Page, text: string): Promise<void> {
  await page.fill('#rail-composer', text);
  await page.click('[data-testid="action-sendCommand-rail"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="action-sendCommand-rail"]')?.getAttribute('aria-busy') !== 'true');
  await page.waitForTimeout(300);
}

async function consoleShots(browser: Browser, theme: Theme, shots: Record<string, { file: string; note: string }>): Promise<void> {
  const file = (board: Board): string => join(OUT, `${board.id}-${board.label}-${theme}-console.png`);
  const shoot = async (page: Page, board: Board, selector?: string, note = 'full page'): Promise<void> => {
    if (!BOARDS.some((b) => b.id === board.id)) return;
    const path = file(board);
    if (selector) await page.locator(selector).first().screenshot({ path });
    else await page.screenshot({ path });
    shots[board.id] = { file: path, note };
  };
  const board = (id: string): Board => BOARDS.find((b) => b.id === id) ?? { id, label: id, design: id };

  const want = (id: string): boolean => BOARDS.some((b) => b.id === id);
  await loadFixture('design-parity');
  let page = await openConsole(browser, theme);
  await shoot(page, board('1a'));
  if (!BOARDS.some((b) => b.id !== '1a')) { await page.close(); return; }
  await page.click('[data-testid="nav-blockers"]');
  await page.waitForSelector('[data-testid="blockers-view"]');
  await shoot(page, board('1b'));
  await page.click('[data-testid="nav-queue"]');
  await page.waitForSelector('[data-testid="queue-view"]');
  await shoot(page, board('1c'));
  await page.click('[data-testid="nav-settings"]');
  await page.waitForSelector('[data-testid="settings"]');
  await shoot(page, board('1e'));
  await page.click('[data-testid="nav-review"]');
  await page.waitForSelector('[data-testid="metric"]');
  await shoot(page, board('1f'));
  await page.click('[data-testid="nav-board"]');
  await page.locator('[data-testid="lane-NWR-226"] [data-testid="primary-action"]').click();
  await page.waitForSelector('[data-testid="ticket-sheet"]');
  await page.waitForTimeout(600);
  await shoot(page, board('1d'));
  await page.keyboard.press('Escape');

  // The rail's card kinds at rest: the question and blocker cards are in the fixture's
  // thread; the confirm card is the server's own gate answering the board's Merge click.
  await page.locator('[data-testid="lane-NWR-96"] [data-testid="primary-action"]').click();
  await page.waitForSelector('[data-testid="conductor-rail"] [data-card="confirm"]');
  await shoot(page, board('1h'), '[data-testid="conductor-rail"] [data-card="question"]', 'the rail question card (the design draws 1h as a 680x520 dialog; turn 2 of the design replaced it with this card)');
  await shoot(page, board('1i'), '[data-testid="conductor-rail"] [data-card="confirm"]', 'the rail confirm card, from the server gate behind the board\'s Merge click');
  await shoot(page, board('1j'), '[data-testid="conductor-rail"] [data-card="blocker"]', 'the rail blocker card');
  await shoot(page, board('1k'), '[data-testid="conductor-rail"] [data-card="decision"]', 'the rail decision card');

  // 1g: a conversation with the Conductor.
  await send(page, 'Why is NWR-141 stuck?');
  await send(page, 'Nudge Dana again and pause NWR-141 until tomorrow.');
  await shoot(page, board('1g'), undefined, 'the board is not dimmed: the design dims it to 40% only to foreground the rail');

  if (!want('2a') && !want('2b') && !want('2c') && !want('2d')) { await page.close(); return; }
  // 2a: the blocker, then a different fix agreed with the agent itself.
  await loadFixture('design-parity');
  await page.close();
  page = await openConsole(browser, theme);
  await page.locator('[data-card="blocker"] .kick').click();
  await page.getByRole('button', { name: /^The agent on/ }).click();
  await send(page, 'What exactly do you need from Sentry? Could you get it from the repo instead?');
  await send(page, 'Do that. Put the DSN caveat in the PR description so QA checks it.');
  await page.getByRole('button', { name: 'Conductor', exact: true }).click();
  await send(page, 'Ask Dana for a new Sentry token, not me.');
  await shoot(page, board('2a'));

  // 2b: confirm with a question first, then the merge.
  await loadFixture('design-parity');
  await page.close();
  page = await openConsole(browser, theme);
  await page.locator('[data-testid="lane-NWR-96"] [data-testid="primary-action"]').click();
  await page.waitForSelector('[data-card="confirm"]');
  await send(page, 'What changed in the reconciliation file? That one worries me.');
  await page.locator('[data-card="confirm"] [data-testid="question-option"]').first().click();
  await page.waitForTimeout(800);
  await shoot(page, board('2b'));

  // 2c: the question answered with a fourth option it did not offer.
  await loadFixture('design-parity');
  await page.close();
  page = await openConsole(browser, theme);
  await page.locator('[data-card="question"] .kick').click();
  await send(page, 'What do our other endpoints do?');
  await send(page, 'Per user with the same helper, 120 a minute. Anonymous callers get a flat 30 a minute per IP.');
  await shoot(page, board('2c'));

  // 2d: the decision challenged and changed.
  await loadFixture('design-parity');
  await page.close();
  page = await openConsole(browser, theme);
  await page.locator('[data-card="decision"] .kick').click();
  await send(page, 'Five attempts feels low. That provider goes down for ten minutes at a time.');
  await send(page, 'Dead-letter table. Replay every five minutes for an hour, then alert.');
  await shoot(page, board('2d'));
  await page.close();
}

/** Mean absolute difference of the two images, in percent, over the smaller common area.
 *  Written as a string: tsx's name-keeping helper does not exist inside the page. */
const DIFF_IN_PAGE = `async ([ua, ub]) => {
  const load = (src) => new Promise((ok, fail) => { const img = new Image(); img.onload = () => ok(img); img.onerror = fail; img.src = src; });
  const [ia, ib] = await Promise.all([load(ua), load(ub)]);
  const w = Math.min(ia.width, ib.width);
  const h = Math.min(ia.height, ib.height);
  const draw = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, w, h).data; };
  const da = draw(ia); const db = draw(ib);
  let sum = 0;
  for (let i = 0; i < da.length; i += 4) sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
  return { percent: Math.round((sum / (da.length / 4) / 765) * 1000) / 10, a: ia.width + 'x' + ia.height, b: ib.width + 'x' + ib.height };
}`;

async function diffPercent(page: Page, a: string, b: string): Promise<{ percent: number; a: string; b: string }> {
  const toDataUrl = (path: string): string => `data:image/png;base64,${readFileSync(path).toString('base64')}`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const inPage = new Function('args', `return (${DIFF_IN_PAGE})(args)`) as (args: string[]) => Promise<{ percent: number; a: string; b: string }>;
  return page.evaluate(inPage, [toDataUrl(a), toDataUrl(b)]);
}

async function main(): Promise<void> {
  const only = process.argv.find((arg) => arg.startsWith('--boards='))?.slice('--boards='.length).split(',');
  const boards = only ? BOARDS.filter((b) => only.includes(b.id)) : [...BOARDS];
  BOARDS.length = 0; BOARDS.push(...boards);
  if (!process.argv.includes('--no-build')) execSync('npm run console:build', { stdio: 'inherit', cwd: ROOT });
  mkdirSync(OUT, { recursive: true });
  process.env['FORGE_STUB_PORT'] = String(CONSOLE_PORT);
  process.env['FORGE_STUB_TOKEN'] = TOKEN;
  const { createStubServer } = await import('../src/console/stub-server.js');
  const stub = createStubServer();
  await new Promise<void>((done) => stub.listen(CONSOLE_PORT, '127.0.0.1', done));
  const design = await serveDesign();
  const browser = await chromium.launch();
  const report: Array<{ board: string; theme: Theme; console: string; design: string; diffPercent: number; sizes: string; note: string }> = [];
  let failed = 0;
  try {
    const compare = await browser.newPage();
    for (const theme of THEMES) {
      const designFiles = await designShots(browser, theme);
      const consoleFiles: Record<string, { file: string; note: string }> = {};
      try {
        await consoleShots(browser, theme, consoleFiles);
      } catch (error) {
        failed += 1;
        console.error(`console shots (${theme}) stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const board of BOARDS) {
        const shot = consoleFiles[board.id];
        const designFile = designFiles[board.id]!;
        if (!shot) { failed += 1; report.push({ board: board.id, theme, console: '', design: designFile, diffPercent: -1, sizes: '', note: 'no console shot' }); continue; }
        const diff = await diffPercent(compare, shot.file, designFile);
        report.push({ board: board.id, theme, console: shot.file, design: designFile, diffPercent: diff.percent, sizes: `console ${diff.a} · design ${diff.b}`, note: shot.note });
        console.log(`${board.id} ${board.label} ${theme}: diff ${diff.percent}% (console ${diff.a}, design ${diff.b})`);
      }
    }
  } finally {
    await browser.close();
    design.close();
    stub.close();
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`${report.filter((r) => r.diffPercent >= 0).length} pairs under ${OUT}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();

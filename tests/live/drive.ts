/**
 * The live driver. Opens the REAL console, walks every screen the router declares,
 * and emits one machine-readable inventory of defects.
 *
 *     npx tsx tests/live/drive.ts                       # against http://127.0.0.1:4120
 *     npx tsx tests/live/drive.ts --base http://...      # somewhere else
 *     npx tsx tests/live/drive.ts --shots <dir>          # save a screenshot per screen
 *     npx tsx tests/live/drive.ts --break <detector>     # inject a specimen defect
 *
 * It runs on demand and never in CI, because it needs a live fleet behind it.
 *
 * It NEVER writes to the pipeline. Every control the driver clicks is checked against
 * `DESTRUCTIVE` first, and everything inside the Needs-you strip is skipped outright:
 * the questions and confirmations on that strip are live state other sessions depend on.
 *
 * The stub suite in `tests/e2e` is not a substitute for this and this is not a
 * substitute for it. The stub suite is the regression net -- it catches a component that
 * stopped rendering what it used to. This driver is the oracle -- it catches a component
 * that renders exactly what it always did while the screen stays unusable.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { chromium, type Browser, type Page, type ElementHandle } from '@playwright/test';

import {
  FALLBACK_STRINGS, runDetectors,
  type Claim, type ControlProbe, type Inventory, type OfferedAsk,
  type RenderedCard, type RequiredRegion, type ScreenCapture,
} from './model.js';

/** Every view `src/console/store.ts` declares, read out of source rather than retyped,
 *  so a view added tomorrow is walked tomorrow. */
function declaredViews(repoRoot: string): string[] {
  const source = readFileSync(join(repoRoot, 'src/console/store.ts'), 'utf8');
  const line = /export type View =([^;]+);/.exec(source);
  if (!line?.[1]) throw new Error('Could not find the View union in src/console/store.ts');
  return [...line[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1] as string);
}

/**
 * Which controls the driver may click. This is an ALLOWLIST, not a denylist, and it is
 * that way because the denylist it replaced failed on its first run: it named `confirm`,
 * `merge` and `dismiss`, and the driver went on to click Link Claude, Unlink, the token
 * cap stepper and two blocker actions, because nobody had thought of those words
 * (2026-09-12; see the brief's Status log). Three of those reached the server and were
 * refused; the rest landed on read routes. Nothing was damaged, and that was luck.
 *
 * Standing order 1 is fail-closed: a control nobody has proven safe reads as dangerous.
 * So a click happens only when the control's own test id matches a name below -- an
 * identifier the component author chose, never the label text, which is copy and changes
 * with the wind.
 */
const SAFE_CONTROLS = [
  /^nav-[a-z-]+$/,          // the seven nav tabs: navigation, no write
  /^needs-you-(next|prev)$/, // paging the strip: read-only, the answer buttons are not here
  /^question-evidence$/,     // the "Why it is asking" disclosure
  /^theme-(dark|light)$/,    // a local preference, stored in the browser
  /^(queue|settings)-width$/, // the width stepper: local layout
  /^lane-more$/,             // a tile's own disclosure
  /^specimen-dead$/,         // the D2 specimen, injected by --break and nothing else
];

/** True when this control is one a person can click without the pipeline noticing. */
function isSafeControl(testid: string): boolean {
  return testid.length > 0 && SAFE_CONTROLS.some((pattern) => pattern.test(testid));
}

interface Args {
  base: string;
  shots: string | null;
  breakId: string | null;
  out: string;
  pageDepth: number;
  /** Walk only this view. For proving a browser-side detector without paying for a full
   *  seven-screen walk; the inventory still names every view it did not reach. */
  only: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : null;
  };
  return {
    base: get('--base') ?? 'http://127.0.0.1:4120',
    shots: get('--shots'),
    breakId: get('--break'),
    out: get('--out') ?? join(process.cwd(), 'tests/live/inventory.json'),
    pageDepth: Number(get('--page-depth') ?? 12),
    only: get('--only'),
  };
}

async function readToken(base: string): Promise<string> {
  const html = await (await fetch(base + '/')).text();
  const match = /name="forge-token" content="([^"]*)"/.exec(html);
  return match?.[1] ?? '';
}

async function getJson(base: string, token: string, path: string): Promise<any> {
  const response = await fetch(base + path, { headers: { 'x-forge-token': token } });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

/**
 * What the SERVER says needs a person, built from its own read routes and from nothing
 * the console believes. This is the independent account D4, D6 and D7 measure against.
 *
 * An ask is anything the fleet has raised and not resolved: an unresolved confirm or
 * blocker card, an unresolved question card, an open blocker row, and any lane carrying
 * an open question. The console is free to present these differently; it is not free to
 * drop one on the floor, and a drop is exactly what the comparison catches.
 */
function offeredAsks(thread: any, lanes: any, blockers: any): OfferedAsk[] {
  const liveKeys = new Set<string>([
    ...(thread.cards ?? []).map((c: any) => c.k),
    ...(thread.messages ?? []).map((m: any) => m.k),
  ]);
  const out: OfferedAsk[] = [];
  for (const card of thread.cards ?? []) {
    if (card.resolved) continue;
    if (card.type !== 'confirm' && card.type !== 'blocker' && card.type !== 'question') continue;
    const targets: string[] = (card.btns ?? [])
      .map((b: any) => String(b.cmd).trim().split(/\s+/)[1])
      .filter((t: unknown): t is string => typeof t === 'string' && t.length > 0);
    // A question card's options are answers, not ids: it is answerable as long as it has
    // options. A confirm or blocker card's button addresses a token, and the token has to
    // still exist for the click to land.
    const answerable = card.type === 'question'
      ? (card.opts ?? []).length > 0
      : targets.length > 0 && targets.every((t) => liveKeys.has(t));
    out.push({
      uid: `card:${card.k}`,
      kind: card.type,
      // `blast` is where a confirm card keeps its one readable sentence, so a reader
      // that skips it calls a perfectly answerable card contentless -- which is what
      // this did on 2026-09-12, reporting D7 against three cards that were fine.
      content: String(card.kicker ?? card.title ?? card.body ?? card.blast ?? card.text ?? '').trim(),
      askedAt: Number(card.ts ?? 0),
      actionTargets: targets,
      actionLive: answerable,
    });
  }
  for (const blocker of blockers.blockers ?? []) {
    if (blocker.state === 'resolved') continue;
    out.push({
      uid: `blocker:${blocker.id ?? blocker.key}`,
      kind: 'blocker',
      content: String(blocker.title ?? blocker.text ?? blocker.reason ?? '').trim(),
      askedAt: Number(blocker.at ?? blocker.raisedAt ?? 0),
      actionTargets: [],
      actionLive: false,
    });
  }
  for (const lane of lanes.lanes ?? []) {
    if (!lane.question || lane.retiredAt) continue;
    out.push({
      uid: `lane:${lane.id}:${lane.question.key}`,
      kind: 'lane',
      content: String(lane.question.text ?? '').trim(),
      askedAt: Number(lane.question.askedAt ?? 0),
      actionTargets: [],
      actionLive: (lane.question.opts ?? []).length > 0,
    });
  }
  // One ask, one entry. The same question reaches the console twice: as a `question`
  // card on `/thread`, and as a `question:<askKey>` row on `/blockers`. Counting both
  // doubled the total to 251 on the first run and made a real finding unreadable
  // (2026-09-12). The card is the richer of the two, so it wins; the blocker row is
  // dropped when its key names a card already held.
  const cardKeys = new Set(
    out.filter((ask) => ask.uid.startsWith('card:')).map((ask) => ask.uid.replace(/^card:(question-)?/, '')),
  );
  const deduped = out.filter((ask) => {
    if (!ask.uid.startsWith('blocker:question:')) return true;
    return !cardKeys.has(ask.uid.replace('blocker:question:', ''));
  });
  // Worst first, oldest first inside a kind -- the order a person meets them in.
  const rank: Record<string, number> = { blocker: 0, confirm: 1, question: 2, lane: 3 };
  deduped.sort((a, b) => (rank[a.kind]! - rank[b.kind]!) || (a.askedAt - b.askedAt));
  return deduped;
}

async function textOf(handle: ElementHandle<Element> | null): Promise<string> {
  if (!handle) return '';
  return (await handle.textContent()) ?? '';
}

/**
 * Every card on screen that a person is meant to read.
 *
 * The selector carries `[data-card]` on purpose. `data-testid="question-card"` is used
 * by two different things: the real card (`QuestionCard`, which sets `data-card`), and
 * the options-and-note block at the foot of a blocker row (`BlockersView.tsx:111`,
 * which does not). The blocker block has no head and no prompt of its own -- the
 * blocker's title sits in a sibling column -- so scraping it as a card produced 92
 * "empty title" findings on the first run, all of them the sensor's fault rather than
 * the console's (2026-09-12). Standing order 6: a measurement that cannot tell the
 * thing under test from its neighbour measures nothing.
 */
async function captureCards(page: Page): Promise<RenderedCard[]> {
  return page.$$eval('[data-testid="question-card"][data-card]', (nodes) => nodes.map((node) => {
    const head = node.querySelector('.key, .kick')?.textContent ?? '';
    const prompt = node.querySelector('p.hd')?.textContent ?? '';
    const stampNodes = node.querySelectorAll('span');
    const stamp = stampNodes.length > 1 ? (stampNodes[1]?.textContent ?? '') : '';
    const options = [...node.querySelectorAll('[data-testid="question-option"], .btn')]
      .map((b) => b.textContent ?? '').filter((t) => t.trim().length > 0);
    const body = node.querySelector('[data-testid="question-evidence-body"]');
    const disclosure = node.querySelector('[data-testid="question-evidence"]');
    const evidenceLines = disclosure === null ? -1 : (body ? body.children.length : 0);
    return { head, prompt, stamp, options, evidenceLines };
  }));
}

/** A blocker row, read as the card a person meets it as: the headline, what clears it,
 *  how long it has been there, and the one action offered. Scraped separately from
 *  `captureCards` because its markup is its own. */
async function captureBlockerRows(page: Page): Promise<RenderedCard[]> {
  return page.$$eval('.blocker-card', (nodes) => nodes.map((node) => {
    const head = node.querySelector('h3.hd')?.textContent ?? '';
    const prompt = node.querySelector('p')?.textContent ?? '';
    const stamp = [...node.querySelectorAll('div')].map((d) => d.textContent ?? '').find((t) => t.startsWith('since ')) ?? '';
    const options = [...node.querySelectorAll('[data-testid="blocker-primary"], [data-testid="question-option"]')]
      .map((b) => (b.textContent ?? '').trim()).filter((t) => t.length > 0);
    const more = node.querySelector('[data-testid="question-evidence"], .disc');
    return { head, prompt, stamp, options, evidenceLines: more === null ? -1 : 0 };
  }));
}

async function captureRequiredRegions(page: Page): Promise<RequiredRegion[]> {
  return page.$$eval('[data-required]', (nodes) => nodes.map((node) => ({
    testid: node.getAttribute('data-testid') ?? '(none)',
    label: node.getAttribute('data-required') ?? '',
    text: node.textContent ?? '',
  })));
}

/**
 * Click every control on this screen that cannot write, and record what the click did.
 * "Did nothing" means all three of: the DOM is byte-identical, no request left the page
 * that a background poll did not account for, and the journal grew by zero rows.
 */
/** The newest journal row's own identity. Cheaper than counting a thousand rows, and a
 *  new row always changes it. */
async function journalMark(base: string, token: string): Promise<string> {
  const body = await getJson(base, token, '/journal?limit=1').catch(() => null);
  const rows: Array<Record<string, unknown>> = body?.rows ?? [];
  // `/journal` answers newest-first and its rows are keyed `jid`/`ts` -- NOT `id`/`at`,
  // which is what the first version of this function read, so every journalDelta it
  // reported was a constant zero and D2's third signal was dead (2026-09-12). `total`
  // is the row the count itself hangs on, so it is checked too.
  const newest = rows[0];
  return newest ? `${String(newest['jid'])}:${String(newest['ts'])}:${String(body?.total ?? '')}` : 'none';
}

async function probeControls(page: Page, base: string, token: string): Promise<ControlProbe[]> {
  const probes: ControlProbe[] = [];
  // Every click re-renders, and the 5s poll re-renders underneath a click that did not.
  // So nothing is held across an iteration: the control is described up front, then
  // re-located by index at the moment it is clicked.
  const selector = 'button:visible, a[href]:visible';
  const described = await page.$$eval(selector, (nodes) => nodes.map((node) => ({
    testid: node.getAttribute('data-testid') ?? '',
    label: (node.textContent ?? '').trim().slice(0, 60),
    inStrip: node.closest('[data-testid="needs-you"]') !== null,
  })));
  const CAP = 40;
  if (described.length > CAP) {
    probes.push({
      testid: '(cap)', label: `${described.length - CAP} further controls on this screen were never clicked`,
      domChanged: false, requests: 0, journalDelta: 0, skipped: `probe capped at ${CAP} controls per screen`,
    });
  }
  for (const [index, { testid, label, inStrip }] of described.slice(0, CAP).entries()) {
    if (inStrip) {
      probes.push({ testid, label, domChanged: false, requests: 0, journalDelta: 0, skipped: 'inside the Needs-you strip: live state' });
      continue;
    }
    if (!isSafeControl(testid)) {
      probes.push({ testid, label, domChanged: false, requests: 0, journalDelta: 0, skipped: 'not on the safe-control allowlist' });
      continue;
    }
    const button = (await page.$$(selector))[index];
    if (!button || !(await button.isEnabled().catch(() => false))) {
      probes.push({ testid, label, domChanged: false, requests: 0, journalDelta: 0, skipped: 'gone or disabled by the time it was reached' });
      continue;
    }
    const before = await page.innerHTML('body');
    const journalBefore = await journalMark(base, token);
    let requests = 0;
    const onRequest = (): void => { requests += 1; };
    page.on('request', onRequest);
    await button.click({ timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(350);
    page.off('request', onRequest);
    const after = await page.innerHTML('body');
    const journalAfter = await journalMark(base, token);
    probes.push({
      testid, label,
      domChanged: before !== after,
      requests,
      journalDelta: journalAfter === journalBefore ? 0 : 1,
    });
  }
  return probes;
}

/** Whatever the strip's counter says, as a number. */
async function stripTotal(page: Page): Promise<string> {
  const counter = await page.$('[data-testid="needs-you-counter"]');
  if (!counter) return (await page.$('[data-testid="needs-you-empty"]')) ? '0' : '(no strip)';
  const text = (await textOf(counter)).trim();
  return /of\s+(\d+)/.exec(text)?.[1] ?? text;
}

async function claimsFor(view: string, page: Page, payloads: Record<string, any>, offered: OfferedAsk[]): Promise<Claim[]> {
  const claims: Claim[] = [];
  const count = async (selector: string): Promise<string> => String((await page.$$(selector)).length);
  claims.push({
    label: 'Needs-you counter total',
    rendered: await stripTotal(page),
    expected: String(offered.length),
    source: '/thread + /lanes + /blockers',
  });
  if (view === 'board') {
    // Containment, not a count. The board legitimately draws one lane more than once --
    // in its group tile and again under Blocked or Waiting to merge -- so a tile count
    // and a lane count disagreeing says nothing (it reported a false drift of 5 against 4
    // on the first run, 2026-09-12). What is checkable without borrowing the console's
    // own grouping rule is that no live lane is missing from the screen entirely.
    const boardText = (await page.textContent('[data-testid="board"]')) ?? '';
    const live = (payloads['lanes']?.lanes ?? []).filter((lane: any) => !lane.retiredAt);
    const missing = live
      .map((lane: any) => String(lane.ticket ?? lane.id))
      .filter((name: string) => !boardText.includes(name));
    claims.push({
      label: 'Live lanes missing from the board',
      rendered: missing.join(', ') || '(none)',
      expected: '(none)',
      source: '/lanes',
    });
  }
  if (view === 'queue') {
    claims.push({
      label: 'Queue rows',
      rendered: await count('[data-testid="queue-card-title"]'),
      expected: String((payloads['queue']?.items ?? []).length),
      source: '/queue',
    });
  }
  if (view === 'blockers') {
    claims.push({
      label: 'Open blockers listed',
      rendered: await count('[data-testid="blocker-primary"]'),
      expected: String((payloads['blockers']?.blockers ?? []).filter((b: any) => b.state !== 'resolved').length),
      source: '/blockers',
    });
  }
  if (view === 'review') {
    claims.push({
      label: 'Proposals listed',
      rendered: await count('[data-testid="proposal"]'),
      expected: String((payloads['proposals']?.rules ?? []).length),
      source: '/proposals',
    });
  }
  return claims;
}

async function walkScreen(
  view: string, reached: ScreenCapture['reached'], page: Page, base: string, token: string,
  payloads: Record<string, any>, offered: OfferedAsk[], errors: { console: string[]; page: string[] },
  shots: string | null,
): Promise<ScreenCapture> {
  errors.console.length = 0;
  errors.page.length = 0;
  await page.waitForTimeout(400);
  const main = await page.$('main, [data-testid="board"], body');
  const textLength = (await textOf(main)).length;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `${view}.png`), fullPage: false });
  }
  const cards = [...await captureCards(page), ...await captureBlockerRows(page)];
  const requiredRegions = await captureRequiredRegions(page);
  const claims = await claimsFor(view, page, payloads, offered);
  const controls = await probeControls(page, base, token);
  return {
    view, reached,
    consoleErrors: [...errors.console],
    pageErrors: [...errors.page],
    requiredRegions, cards, controls, claims, textLength,
  };
}

/**
 * Specimen injection. Each id breaks the page (or the capture) in exactly the way its
 * detector claims to catch, so the detector can be watched going red without waiting for
 * the real system to produce the defect. Standing order 2: a detector that has never
 * fired is not a detector.
 */
async function injectBreak(breakId: string, page: Page, capture: Partial<ScreenCapture>, offered: OfferedAsk[]): Promise<void> {
  if (breakId === 'D1') {
    await page.evaluate(() => {
      const doc = (globalThis as { document?: any }).document;
      const region = doc.createElement('div');
      region.setAttribute('data-required', 'Why it is asking');
      region.setAttribute('data-testid', 'specimen-region');
      doc.body.appendChild(region);
    });
  }
  if (breakId === 'D2') {
    await page.evaluate(() => {
      const doc = (globalThis as { document?: any }).document;
      const dud = doc.createElement('button');
      dud.textContent = 'Specimen dead control';
      dud.setAttribute('data-testid', 'specimen-dead');
      // First, not last: the probe is capped at 40 controls a screen, and appending put
      // the specimen past the cap where it was never clicked (2026-09-12).
      doc.body.insertBefore(dud, doc.body.firstChild);
    });
  }
  if (breakId === 'D4') {
    // The page has already rendered; move the server's number underneath it.
    capture.claims = [{ label: 'Specimen count', rendered: '4', expected: '5', source: '/lanes (moved underneath the render)' }];
  }
  if (breakId === 'D3') {
    // Hide one nav control. The route stays declared and stays in the DOM; a person can
    // no longer click their way to it, which is exactly what D3 claims to catch.
    await page.addStyleTag({ content: '[data-testid="nav-machine"]{display:none !important}' });
  }
  if (breakId === 'D5') {
    // Raised on a timer rather than once, because `walkScreen` clears the collected
    // errors as it enters each screen -- a single error at load would be wiped before
    // the first capture and the detector would never be watched firing.
    await page.evaluate(() => {
      (globalThis as { setInterval?: any }).setInterval(() => console.error('Specimen console error'), 200);
    });
  }
  if (breakId === 'D6') {
    offered.push({ uid: 'specimen', kind: 'confirm', content: 'Specimen stale ask', askedAt: Date.now() - 200 * 3_600_000, actionTargets: ['gone'], actionLive: false });
  }
  if (breakId === 'D7') {
    offered.unshift({ uid: 'specimen-empty', kind: 'confirm', content: '', askedAt: 0, actionTargets: [], actionLive: false });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const views = declaredViews(repoRoot);

  // Fail loudly if a fallback constant was renamed out from under D1.
  const componentSource = ['src/console/components/NeedsYou.tsx', 'src/console/components/QuestionCard.tsx', 'src/forge/console/command.ts']
    .map((p) => readFileSync(join(repoRoot, p), 'utf8')).join('\n');
  const missing = FALLBACK_STRINGS.filter((s) => !componentSource.includes(s));
  if (missing.length === FALLBACK_STRINGS.length) {
    throw new Error('None of the fallback constants D1 watches for still exist in source; D1 is blind.');
  }

  const token = await readToken(args.base);
  const payloads: Record<string, any> = {};
  for (const path of ['thread', 'lanes', 'blockers', 'queue', 'proposals', 'caps', 'integrations']) {
    payloads[path] = await getJson(args.base, token, '/' + path).catch((e: Error) => ({ __error: e.message }));
  }
  const offered = offeredAsks(payloads['thread'], payloads['lanes'], payloads['blockers']);

  let browser: Browser | null = null;
  const screens: ScreenCapture[] = [];
  const renderedOrder: string[] = [];
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = { console: [] as string[], page: [] as string[] };
    // The preview server (tests/live/preview.ts) proxies reads and nothing else, so the
    // page's live-feed socket cannot connect there. That failure is the harness's, and
    // counting it as a console defect would make every preview run look broken.
    const HARNESS_NOISE = /WebSocket connection to 'ws:\/\/[^']*\/events'/;
    page.on('console', (message) => {
      if (message.type() === 'error' && !HARNESS_NOISE.test(message.text())) errors.console.push(message.text());
    });
    page.on('pageerror', (error) => errors.page.push(error.message));

    await page.goto(args.base + '/', { waitUntil: 'networkidle' });
    if (args.breakId) await injectBreak(args.breakId, page, {}, offered);

    // The landing page, then every declared view by clicking its own nav control. A view
    // whose nav control is not there, or whose click does not land, stays unreached --
    // and an unreached view reads as unknown, never as clean.
    const landingView = (await page.$('[data-testid="nav-board"][aria-current="page"]')) ? 'board' : 'board';
    const landing = await walkScreen(landingView, 'landing', page, args.base, token, payloads, offered, errors, args.shots);
    if (args.breakId === 'D4') landing.claims = [{ label: 'Specimen count', rendered: '4', expected: '5', source: '/lanes (moved underneath the render)' }];
    screens.push(landing);

    // Page the strip, so the order a person meets is recorded rather than assumed. Bounded:
    // Next is read-only, but 90 clicks is 90 renders and the budget is wall clock.
    for (let i = 0; i < (args.only === null ? args.pageDepth : 0); i += 1) {
      const card = await page.$('[data-testid="needs-you"] [data-testid="question-card"]');
      if (!card) break;
      const head = (await textOf(await card.$('.key, .kick'))).trim();
      const prompt = (await textOf(await card.$('p.hd'))).trim();
      renderedOrder.push(`${head} :: ${prompt}`.slice(0, 120));
      const next = await page.$('[data-testid="needs-you-next"]');
      if (!next || !(await next.isEnabled())) break;
      await next.click();
      await page.waitForTimeout(120);
    }

    for (const view of views) {
      if (view === landingView) continue;
      if (args.only !== null && view !== args.only) {
        screens.push({
          view, reached: 'skipped', consoleErrors: [], pageErrors: [],
          requiredRegions: [], cards: [], controls: [], claims: [], textLength: 0,
        });
        continue;
      }
      // Present in the DOM is not the same as reachable: a nav control a person cannot
      // see is a route they cannot click to, so visibility is what is asked.
      const nav = await page.$(`[data-testid="nav-${view}"]`);
      const clickable = nav !== null && await nav.isVisible().catch(() => false);
      if (!clickable) {
        screens.push({
          view, reached: 'unreachable', consoleErrors: [], pageErrors: [],
          requiredRegions: [], cards: [], controls: [], claims: [], textLength: 0,
        });
        continue;
      }
      await nav.click();
      await page.waitForTimeout(500);
      screens.push(await walkScreen(view, 'click', page, args.base, token, payloads, offered, errors, args.shots));
    }
  } finally {
    await browser?.close();
  }

  const partial: Omit<Inventory, 'defects'> = {
    at: new Date().toISOString(),
    target: args.base,
    head: null,
    declaredViews: views,
    walkedViews: screens.filter((s) => s.reached === 'landing' || s.reached === 'click').map((s) => s.view),
    screens, offered, renderedOrder,
  };
  const inventory: Inventory = { ...partial, defects: runDetectors(partial, Date.now()) };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(inventory, null, 2));

  const unwalked = views.filter((v) => !inventory.walkedViews.includes(v));
  const byId: Record<string, number> = {};
  for (const defect of inventory.defects) byId[defect.id] = (byId[defect.id] ?? 0) + 1;
  console.log(`target       ${args.base}`);
  console.log(`walked       ${inventory.walkedViews.join(', ') || '(none)'}`);
  console.log(`UNKNOWN      ${unwalked.join(', ') || '(none)'}   <- never "clean"`);
  console.log(`asks offered ${offered.length}`);
  // D2 coverage, said out loud. The safe-control allowlist is narrow on purpose, so
  // "no dead controls" means "none among the few that were clicked" and must never be
  // read as "none on the screen". Standing order 1: unprobed is unknown, not clean.
  const probed = inventory.screens.flatMap((screen) => screen.controls);
  const clicked = probed.filter((control) => control.skipped === undefined).length;
  console.log(`clicked      ${clicked} of ${probed.length} controls seen; the rest are UNKNOWN, not clean`);
  console.log(`defects      ${inventory.defects.length}  ${JSON.stringify(byId)}`);
  for (const defect of inventory.defects.slice(0, 25)) {
    console.log(`  ${defect.id} [${defect.view}] ${defect.what}`);
  }
  if (inventory.defects.length > 25) console.log(`  ... and ${inventory.defects.length - 25} more in ${args.out}`);
  console.log(`inventory    ${args.out}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

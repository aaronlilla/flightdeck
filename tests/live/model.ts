/**
 * The live driver's data model and its seven detectors.
 *
 * Why this file is separate from `drive.ts`: a detector has to be provable. Everything
 * here is a pure function over a capture, so a deliberately broken specimen can be handed
 * to it without a browser, and `tests/live/detectors.test.ts` watches each one go red.
 * `drive.ts` owns the browser and produces the captures; this file owns the judgement.
 *
 * Standing order 6 (sensor validity) shapes the whole design. The existing 42 Playwright
 * specs run against a stub whose fixtures were written from the same assumptions as the
 * components under test, so they cannot see a component rendering the wrong thing. The
 * detectors below never ask the console what it believes. They take two independent
 * accounts of the same fact -- what the server's own read routes hold, and what the
 * browser painted -- and fire on the disagreement.
 */

/** Strings a component falls back to when the data it wanted is not there. A rendered
 *  title equal to one of these is a placeholder by definition, not content. Sourced from
 *  the components themselves; `drive.ts` asserts each one still appears in source, so a
 *  renamed fallback fails loudly rather than silently retiring a detector. */
export const FALLBACK_STRINGS = [
  'confirm?',
  'plan',
  'No question text',
  'Nothing needs you',
  '--',
  '—',
] as const;

/**
 * The subset of the above that must still appear verbatim in the components' source, so
 * a renamed constant fails the run loudly instead of retiring D1 in silence.
 *
 * Each is spelled the way it is actually WRITTEN, which is not the same for all three.
 * `confirm?` is pinned with its quotes because the bare word also matches every
 * TypeScript optional property named `confirm` -- three of those live in the same file,
 * so the bare form passed while the minted string had been renamed away. The other two
 * carry no punctuation that collides with anything and one of them is JSX text rather
 * than a literal, so they are pinned bare.
 *
 * The two dashes are deliberately NOT here. They are what a component renders when it has
 * no value, not literals anyone wrote, and `--` occurs in ordinary comment punctuation
 * 64 times across the files that get grepped -- so including them made the guard read as
 * satisfied no matter what else had been renamed (found in review, 2026-09-12).
 */
export const SOURCE_PINNED_FALLBACKS = [
  "'confirm?'",
  'No question text',
  'Nothing needs you',
] as const;

/** How old an offered item may be before D6 asks whether its own action still works.
 *  24h is the bound: the console polls every 5s and the fleet turns work over in
 *  minutes, so anything a person has been offered for a day has outlived its context. */
export const STALE_ACTIONABLE_MS = 24 * 60 * 60 * 1000;

export type DefectId = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7';

export interface Defect {
  id: DefectId;
  /** The screen it was found on, or `*` for a finding about the console as a whole. */
  view: string;
  /** What the reader would see, in one line. */
  what: string;
  /** The two accounts that disagreed, or the single observation that fired. */
  evidence: Record<string, unknown>;
}

/**
 * One thing the SERVER says needs a person, read straight off the read routes. This is
 * the independent account: it is built from `/thread` and `/lanes` payloads without
 * asking any console component what it thinks a need is.
 */
export interface OfferedAsk {
  /** Stable identity: the message key, or `lane:<id>:<question key>`. */
  uid: string;
  kind: 'confirm' | 'blocker' | 'question' | 'lane';
  /** The words a person would have to read to answer it. Empty means contentless. */
  content: string;
  /** When it was raised, epoch ms. */
  askedAt: number;
  /** The ids this ask's own buttons address. Empty when the ask carries no buttons. */
  actionTargets: string[];
  /** True when every one of `actionTargets` still exists in the server's own state, so
   *  the action can land. An ask with no buttons at all is not answerable by button and
   *  reads as false only when it also carries no free-text route. */
  actionLive: boolean;
}

/** One card the BROWSER actually painted. */
export interface RenderedCard {
  /** The kicker line. */
  head: string;
  /** The question or blast text under it. */
  prompt: string;
  /** The right-hand stamp ("asked 3 h ago"). */
  stamp: string;
  options: string[];
  /** How many evidence lines the disclosure holds once opened; -1 when there is no
   *  disclosure at all. */
  evidenceLines: number;
}

/** A region the layout marks as required (`data-required` in the DOM) and what it held. */
export interface RequiredRegion {
  testid: string;
  label: string;
  text: string;
}

/** One control the driver clicked, and what the click did. Never a destructive one:
 *  `drive.ts` refuses anything that writes to the real pipeline. */
export interface ControlProbe {
  testid: string;
  label: string;
  /** True when the click changed the DOM in any way. */
  domChanged: boolean;
  /** How many requests the page issued inside the settle window, polls excluded. */
  requests: number;
  /** Journal rows added between just before and just after the click. */
  journalDelta: number;
  /** Set when the driver skipped the click on purpose. */
  skipped?: string;
}

/**
 * One number, state, age or identifier on screen, with where it should have come from.
 * `rendered` is scraped from the DOM; `expected` is derived from the endpoint payload
 * the screen was fed. A claim whose two sides disagree is drift.
 */
export interface Claim {
  label: string;
  rendered: string;
  expected: string;
  /** The endpoint the expected value was derived from, for the report. */
  source: string;
}

export interface ScreenCapture {
  view: string;
  /** `unreachable` means the driver looked for this view's own nav control and it was not
   *  there. `skipped` means the run was narrowed with `--only` and never looked; it reads
   *  as UNKNOWN in the inventory and never as a finding. */
  reached: 'landing' | 'click' | 'unreachable' | 'skipped';
  consoleErrors: string[];
  pageErrors: string[];
  requiredRegions: RequiredRegion[];
  cards: RenderedCard[];
  controls: ControlProbe[];
  claims: Claim[];
  /** Text length of the main region, so an empty screen is visible in the inventory. */
  textLength: number;
}

export interface Inventory {
  at: string;
  target: string;
  /** The head the server was serving when this ran. */
  head: string | null;
  /** Every view the router declares. */
  declaredViews: string[];
  /** The views the driver actually walked. Anything in `declaredViews` and not here is
   *  UNKNOWN, never clean -- standing order 1. */
  walkedViews: string[];
  screens: ScreenCapture[];
  /** What the server says needs a person, in the order the strip offered them. */
  offered: OfferedAsk[];
  /** The order the strip actually rendered, by uid, as far as the driver paged. */
  renderedOrder: string[];
  defects: Defect[];
}

function isFallback(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || (FALLBACK_STRINGS as readonly string[]).includes(trimmed);
}

/** D1 -- placeholder render. A region the layout marks required renders empty, or a
 *  card's title is a fallback constant, or the title and the body are the same string
 *  (which is what a component does when it had one field and needed two). */
export function detectD1(screen: ScreenCapture): Defect[] {
  const out: Defect[] = [];
  for (const region of screen.requiredRegions) {
    if (region.text.trim().length > 0) continue;
    out.push({
      id: 'D1', view: screen.view,
      what: `Required region "${region.label}" rendered empty`,
      evidence: { testid: region.testid, text: region.text },
    });
  }
  for (const card of screen.cards) {
    if (isFallback(card.head)) {
      out.push({
        id: 'D1', view: screen.view,
        what: `Card title is the placeholder "${card.head.trim() || '(empty)'}"`,
        evidence: { head: card.head, prompt: card.prompt },
      });
      continue;
    }
    if (card.head.trim() === card.prompt.trim() && card.head.trim().length > 0) {
      out.push({
        id: 'D1', view: screen.view,
        what: 'Card title and body are the same string, so one of the two carries no information',
        evidence: { head: card.head, prompt: card.prompt },
      });
      continue;
    }
    if (isFallback(card.prompt)) {
      out.push({
        id: 'D1', view: screen.view,
        what: `Card body is the placeholder "${card.prompt.trim() || '(empty)'}"`,
        evidence: { head: card.head, prompt: card.prompt },
      });
    }
  }
  return out;
}

/** D2 -- dead control. A click that produced no DOM change, no request and no journal
 *  row did nothing a person can perceive or the system can remember. */
export function detectD2(screen: ScreenCapture): Defect[] {
  return screen.controls
    .filter((c) => c.skipped === undefined && !c.domChanged && c.requests === 0 && c.journalDelta === 0)
    .map((c) => ({
      id: 'D2' as const, view: screen.view,
      what: `Control "${c.label || c.testid}" does nothing when clicked`,
      evidence: { testid: c.testid, domChanged: false, requests: 0, journalDelta: 0 },
    }));
}

/** D3 -- unreachable. A route the router declares that no click from the landing page
 *  reaches. Computed against the declared list, so a new view is covered the day it is
 *  added rather than the day someone remembers to list it. */
export function detectD3(inventory: Pick<Inventory, 'declaredViews' | 'screens'>): Defect[] {
  // Only a view the driver actually tried and could not reach is a defect. A view it
  // never looked at is unknown, and unknown is reported by the inventory's own
  // walked/UNKNOWN split rather than as a finding here.
  const tried = new Set(inventory.screens.filter((s) => s.reached === 'unreachable').map((s) => s.view));
  return inventory.declaredViews
    .filter((view) => tried.has(view))
    .map((view) => ({
      id: 'D3' as const, view,
      what: `Route "${view}" is declared by the router and cannot be reached by clicking from the landing page`,
      evidence: { declared: true, reachedByClick: false },
    }));
}

/** D4 -- drift. A value on screen that disagrees with the endpoint it came from. */
export function detectD4(screen: ScreenCapture): Defect[] {
  return screen.claims
    .filter((claim) => claim.rendered !== claim.expected)
    .map((claim) => ({
      id: 'D4' as const, view: screen.view,
      what: `${claim.label}: screen says "${claim.rendered}", ${claim.source} says "${claim.expected}"`,
      evidence: { ...claim },
    }));
}

/** D5 -- page error. Any console error or unhandled rejection, on any screen. */
export function detectD5(screen: ScreenCapture): Defect[] {
  const out: Defect[] = [];
  for (const message of screen.consoleErrors) {
    out.push({ id: 'D5', view: screen.view, what: `Console error: ${message}`, evidence: { message } });
  }
  for (const message of screen.pageErrors) {
    out.push({ id: 'D5', view: screen.view, what: `Unhandled rejection: ${message}`, evidence: { message } });
  }
  return out;
}

/** D6 -- stale-actionable. An item offered as actionable whose age exceeds the bound and
 *  whose own action cannot clear it. Both halves are required: an old ask that still
 *  works is a backlog, not a defect, and a dead action on a fresh ask is a race. */
export function detectD6(offered: OfferedAsk[], now: number): Defect[] {
  return offered
    .filter((ask) => now - ask.askedAt > STALE_ACTIONABLE_MS && !ask.actionLive)
    .map((ask) => ({
      id: 'D6' as const, view: '*',
      what: `"${ask.content || ask.uid}" has been offered for ${Math.round((now - ask.askedAt) / 3_600_000)}h and its own action addresses nothing that exists`,
      evidence: { uid: ask.uid, kind: ask.kind, ageHours: Math.round((now - ask.askedAt) / 3_600_000), actionTargets: ask.actionTargets },
    }));
}

/** D7 -- buried. A contentless item ranked ahead of an item carrying content. Fires once
 *  per run with the counts, because 67 instances of one sort order is one defect. */
export function detectD7(offered: OfferedAsk[]): Defect[] {
  const contentless = offered.filter((ask) => ask.content.trim().length === 0 || isFallback(ask.content));
  const withContent = offered.filter((ask) => !(ask.content.trim().length === 0 || isFallback(ask.content)));
  if (contentless.length === 0 || withContent.length === 0) return [];
  const firstEmpty = offered.findIndex((ask) => contentless.includes(ask));
  const lastFull = offered.reduce((acc, ask, i) => (withContent.includes(ask) ? i : acc), -1);
  if (firstEmpty === -1 || lastFull === -1 || firstEmpty > lastFull) return [];
  // Every contentless item ranked ahead of the LAST readable one. Counting only the ones
  // ahead of the FIRST readable one reported "0 contentless items rank ahead" for an
  // interleaved order -- a defect whose own number said nothing was wrong (found in
  // review, 2026-09-12).
  const buried = offered.slice(0, lastFull).filter((ask) => contentless.includes(ask)).length;
  // What it costs a person: how many cards they page past before one they can read.
  const clicksToFirstReadable = offered.findIndex((ask) => withContent.includes(ask));
  return [{
    id: 'D7', view: '*',
    what: `${buried} contentless item(s) rank ahead of an item a person can read`
      + (clicksToFirstReadable > 0 ? `; ${clicksToFirstReadable} of them before the first one` : ''),
    evidence: {
      contentless: contentless.length,
      withContent: withContent.length,
      buried,
      clicksToFirstReadable,
      firstContentlessAt: firstEmpty,
      lastReadableAt: lastFull,
    },
  }];
}

/** Every detector, over one finished walk. */
export function runDetectors(inventory: Omit<Inventory, 'defects'>, now: number): Defect[] {
  const out: Defect[] = [];
  for (const screen of inventory.screens) {
    out.push(...detectD1(screen), ...detectD2(screen), ...detectD4(screen), ...detectD5(screen));
  }
  out.push(...detectD3(inventory));
  out.push(...detectD6(inventory.offered, now));
  out.push(...detectD7(inventory.offered));
  return out;
}

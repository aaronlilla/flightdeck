/**
 * Named scenarios the e2e suite selects with `POST /__test/fixture?name=<id>`
 * (see `stub-server.ts`). Each spec picks its own scenario before it navigates,
 * so specs never depend on the seed board or on each other's mutations -- the
 * default board (`seedLanes()` et al) stays the one every non-e2e caller sees.
 *
 * Every id here also has to survive `check:agnostic`, so lane and ticket ids
 * follow the same generic `FLT-`/`BBZ-` convention `lanes.ts` already uses.
 */
import type { Integration, Lane, Message, QueueItem, Rule } from '../../shared/console-model.js';
import { computeYou } from '../../forge/console/laneGlance.js';

const T0 = Date.parse('2026-01-06T14:07:52Z');

function lane(partial: Partial<Lane> & Pick<Lane, 'id' | 'state'>): Lane {
  const built: Lane = {
    ticket: null,
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    did: null, now: '', you: null,
    model: 'sonnet-5',
    modelId: 'claude-sonnet-5',
    className: 'implement',
    repo: 'flightdeck-api',
    attempt: 1,
    reason: null,
    stepN: 1,
    stepTotal: 6,
    stepText: 'working',
    ctxTokens: 40_000,
    ctxCeiling: 200_000,
    ctxCompactAt: 180_000,
    tokens: 240_000,
    tokenCap: 4_000_000,
    tokensPerMin: 0,
    fails: 0,
    hop: 2,
    hopStatus: 'live',
    observedAt: T0,
    verifiedAt: T0,
    heart: false,
    since: T0,
    startedAt: T0,
    endedAt: null,
    question: null,
    pr: null,
    sandbox: null,
    blockedBy: null,
    runaway: false,
    needsAaron: null,
    live: { alive: false, pid: null, lastEventAt: null, checkedAt: T0 },
    ...partial,
  };
  if (partial.now === undefined) built.now = built.plain;
  if (partial.you === undefined) built.you = computeYou(built);
  return built;
}

/** Cut-line #1: an empty fleet -- no lanes, no rules, no journal, no queue. Every
 *  "N of the fleet" readout (the all-chip count, the needs-you strip, the queue's
 *  own empty state) has to hold together with nothing behind it. */
export function emptyLanes(): Lane[] {
  return [];
}

/** The sentinel repo a write handler checks for before running its normal effect
 *  (see `stub-server.ts#maybeUnbuilt`), standing in for a mechanism the real
 *  server has not built yet -- the contract's own "answers 501" case. */
export const UNBUILT_REPO = '__stub-unbuilt__';

/** Cut-line #1: one lane per state, plus the two variants a bare state doesn't
 *  distinguish (`running` normal vs. `runaway`, `blocked` on an integration vs.
 *  a failed gate) -- twelve lanes, twelve CTAs, matching `laneCta()`'s own switch
 *  one for one so a spec can assert every row of the HANDOFF's CTA table renders,
 *  not only the handful the seed board happens to carry. */
export function statesLanes(): Lane[] {
  const now = Date.now();
  return [
    lane({ id: 'FLT-301', state: 'running', heart: true, stepText: 'writing a test' }),
    lane({
      id: 'FLT-302', state: 'running', runaway: true, heart: true, fails: 3,
      tokens: 5_000_000, tokenCap: 1_000_000, stepText: 'retrying a flaky build',
    }),
    lane({ id: 'FLT-303', state: 'handed-off', heart: true, hop: 3, stepText: 'handed off to the gate council' }),
    lane({ id: 'FLT-304', state: 'paused', stepText: 'paused by the operator' }),
    lane({
      id: 'FLT-305', state: 'parked', stepText: 'blocked on a question',
      question: { key: 'ask-305', text: 'ship it anyway?', opts: ['yes', 'no'], askedAt: now },
    }),
    lane({ id: 'FLT-306', state: 'done', stepText: 'ready to merge', pr: { no: 1, url: 'https://example.invalid/pr/1', files: 2, add: 10, del: 1, draft: false } }),
    lane({ id: 'FLT-307', state: 'merged', stepText: 'merged', pr: { no: 2, url: 'https://example.invalid/pr/2', files: 2, add: 10, del: 1, draft: false } }),
    lane({ id: 'FLT-308', state: 'blocked', reason: 'gate: FIX FIRST', stepText: 'the gate council failed this attempt' }),
    lane({ id: 'FLT-309', state: 'blocked', blockedBy: 'aws', reason: 'blocked on integration:aws', stepText: 'waiting on the AWS integration' }),
    lane({ id: 'FLT-310', state: 'exhausted', ctxTokens: 199_000, stepText: 'ran out of context before finishing' }),
    lane({ id: 'FLT-311', state: 'killed', stepText: 'killed' }),
    lane({ id: 'FLT-312', state: 'unverified', stepText: 'finished without a gate verdict' }),
  ];
}

/** Cut-line #1: an exhausted lane whose action route the stub deliberately has
 *  not built (`repo: UNBUILT_REPO`) -- the contract's 501 case, so the rail's
 *  refusal card has something real to render instead of a hand-typed fixture. */
export function refusalLanes(): Lane[] {
  return [lane({ id: 'FLT-401', state: 'exhausted', repo: UNBUILT_REPO, ctxTokens: 199_000, stepText: 'ran out of context before finishing' })];
}

/** Cut-line #1: a parked lane whose question the operator already answered from
 *  a second tab (or the stub's own race) -- so the rail's `answer` command has
 *  no parked lane left to resolve when this tab's stale question card is
 *  clicked a second time. The lane starts `running`; the question card is
 *  carried in the matching thread fixture (`raceThread`) rather than on the
 *  lane, which is exactly the race: the card is stale, the lane already moved. */
export function resumedRaceLanes(): Lane[] {
  return [lane({ id: 'FLT-402', state: 'running', heart: true, stepText: 'already resumed' })];
}

export function raceThread(): Message[] {
  const now = Date.now() - 60_000;
  return [{
    k: 'race-q1', type: 'question', text: 'the migration column should be NOT NULL or nullable with a backfill job?',
    ts: now, source: 'FLT-402', lane: 'FLT-402', askKey: 'ask-race',
    opts: ['NOT NULL', 'nullable + backfill'],
  }];
}

/** W5 (ask-cards-and-type-scale): the shared payload behind `askRecommendedLanes` and
 *  `askRecommendedThread`. Both fixtures describe the same ask (FLT-410's retry-backoff
 *  question) in two different shapes -- a lane's `question` field and a persisted
 *  `type: 'question'` message -- and previously hard-coded that payload twice, which let
 *  an edit to one drift from the other. One source now, read by both. */
const ASK_410_NOW = Date.now() - 90_000;
const ASK_410 = {
  key: 'ask-410',
  text: 'the retry backoff should cap at 30s or keep doubling forever?',
  opts: ['Cap at 30s', 'Keep doubling forever', 'Cap at 60s', 'Something else, I will type it'] as string[],
  recommended: 0,
};

/** A parked lane whose question already carries four options and a recommendation
 *  (W1's `completeAskOptions` shape), for the e2e coverage that picking the recommended
 *  option and sending clears the ask from Needs You. */
export function askRecommendedLanes(): Lane[] {
  return [
    lane({
      id: 'FLT-410', state: 'parked', stepText: 'blocked on a question',
      question: {
        key: ASK_410.key, text: ASK_410.text, opts: ASK_410.opts,
        askedAt: ASK_410_NOW, recommended: ASK_410.recommended, optionSource: 'drafted',
      },
    }),
  ];
}

/** Paired thread for `askRecommendedLanes`. Carries a persisted `type: 'question'`
 *  message that matches the lane's `question` field, so `runThreadPlain` and
 *  `runThreadVerbose` use this real card instead of synthesizing a plain event line
 *  (plain mode) or a card with no recommendation (verbose mode). Same pattern as
 *  `raceThread`. */
export function askRecommendedThread(): Message[] {
  return [{
    k: 'ask-410-q', type: 'question', text: ASK_410.text,
    ts: ASK_410_NOW, source: 'FLT-410', lane: 'FLT-410', askKey: ASK_410.key,
    opts: ASK_410.opts, recommended: ASK_410.recommended,
  }];
}

/** Cut-line #2: one lane per `MessageType` the rail's `MessageCard` switch
 *  renders, so the whole gallery is exercised rather than the seed thread's
 *  three types. */
export function galleryThread(): Message[] {
  const now = Date.now();
  return [
    { k: 'g-event', type: 'event', text: 'FLT-501 parked -- needs an answer', ts: now - 9 * 60_000, source: 'system', lane: 'FLT-501', verifiedAt: now - 9 * 60_000 },
    { k: 'g-operator', type: 'operator', text: 'pause everything', ts: now - 8 * 60_000, source: 'operator' },
    {
      k: 'g-reply', type: 'reply', text: 'FLT-501 is over its cap and has failed twice. Recommend killing it.', ts: now - 7 * 60_000,
      source: 'conductor', btns: [{ label: 'Kill FLT-501', cmd: 'kill FLT-501', cls: 'destroy' }],
    },
    {
      k: 'g-question', type: 'question', text: 'the migration column should be NOT NULL or nullable with a backfill job?',
      ts: now - 6 * 60_000, source: 'FLT-501', lane: 'FLT-501', askKey: 'ask-gallery',
      opts: ['NOT NULL', 'nullable + backfill'],
    },
    {
      k: 'g-plan', type: 'plan', text: 'merge ready lanes', ts: now - 5 * 60_000, source: 'conductor',
      items: [{ text: 'merge FLT-306', irreversible: true }, { text: 'post a journal receipt', irreversible: false }],
    },
    {
      k: 'g-confirm', type: 'confirm', text: 'Kill FLT-501?', ts: now - 4 * 60_000, source: 'conductor',
      blast: 'discards the working diff and stops the sandbox.',
    },
    { k: 'g-receipt', type: 'receipt', text: 'FLT-501 killed', ts: now - 3 * 60_000, source: 'conductor', jid: 'J-90001', undoable: false },
    { k: 'g-refusal', type: 'refusal', text: `refused: 30M tokens is above the org hard limit 20M tokens (FD-7)`, ts: now - 2 * 60_000, source: 'conductor' },
    {
      k: 'g-pr', type: 'pr', text: 'draft PR #9 opened', ts: now - 60_000, source: 'FLT-306',
      pr: { no: 9, url: 'https://example.invalid/pr/9', files: 3, add: 40, del: 5, draft: true },
    },
    { k: 'g-thinking', type: 'thinking', text: '', ts: now, source: 'conductor' },
  ];
}

/** Cut-line #2: a fleet at operational scale -- 2000 lanes -- to prove the board
 *  holds together (renders, counts, filters) at ten times what any hand-written
 *  fixture would cover, not just at the seed's baker's dozen. */
export function bigLanes(count = 2000): Lane[] {
  const now = Date.now();
  const states: Lane['state'][] = ['running', 'paused', 'blocked', 'done', 'merged', 'parked', 'exhausted'];
  const out: Lane[] = [];
  for (let i = 0; i < count - 1; i += 1) {
    const state = states[i % states.length] as Lane['state'];
    out.push(lane({
      id: `FLT-${9000 + i}`,
      ticket: `FLT-${9000 + i}`,
      state,
      heart: state === 'running',
      repo: i % 3 === 0 ? 'flightdeck-api' : i % 3 === 1 ? 'flightdeck-rn' : 'flightdeck-docs',
      tokens: 10_000 + i * 137,
      observedAt: now - (i % 20) * 1000,
      verifiedAt: state === 'running' ? now - (i % 20) * 1000 : null,
      question: state === 'parked' ? { key: `ask-${i}`, text: 'ok to proceed?', opts: ['yes', 'no'], askedAt: now } : null,
    }));
  }
  // Sweep #19: a tile's title is meant to clamp to two lines regardless of how long
  // the ticket key or the title text runs -- this lane's own key+title run to 140
  // characters combined, long enough that an unclamped tile would grow past two lines.
  out.push(lane({
    id: 'FLT-9999-long-title-clamp-check',
    ticket: 'FLT-9999-long-title-clamp-check',
    title: 'the withdrawal fee calculator rounds down instead of to the nearest cent on every payout over five hundred dollars across every operator on the platform',
    state: 'running', heart: true, repo: 'flightdeck-api',
  }));
  return out;
}

/** Cut-line #1: one queue item per (source, state) pair the current contract
 *  defines (`QueueSource` x `QueueItemState`, 4 x 7): every add path, every
 *  card the queue view's `STATE_TAXONOMY` renders. */
export function matrixQueue(): QueueItem[] {
  const now = Date.now();
  const sources: QueueItem['source'][] = ['ticket', 'brief', 'query', 'backlog'];
  const states: QueueItem['state'][] = ['queued', 'planning', 'running', 'parked', 'review', 'failed', 'done'];
  const out: QueueItem[] = [];
  let n = 0;
  for (const source of sources) {
    for (const state of states) {
      n += 1;
      const id = `Q-matrix-${n}`;
      const ticket = source === 'ticket' ? `FLT-${600 + n}` : source === 'query' || source === 'backlog' ? `FLT-${600 + n}` : null;
      // D2.3: the very first `failed` item stands in for A.1's fix round -- one
      // relaunch used, and the findings it is retrying against carried the same
      // place every other reason already renders. The very first `review` item
      // carries the council's own notes. The very first `done` item is a hotfix
      // instead of its source group's own `ticket`, since a hotfix (A.6/A.7) is
      // the only source `done` ever offers Promote for -- none of the three swaps
      // changes the total item count or which source/state chips show up at least
      // once, so they leave every already-green spec in this fixture untouched.
      const isFirstFailed = source === 'ticket' && state === 'failed';
      const isFirstReview = source === 'ticket' && state === 'review';
      const isFirstDone = source === 'ticket' && state === 'done';
      out.push({
        id,
        source: isFirstDone ? 'hotfix' : source,
        input: source === 'brief' ? '# Goal: fix the thing' : source === 'query' ? 'sprint in openSprints()' : source === 'backlog' ? 'project = FLT and status = Backlog' : `FLT-${600 + n}`,
        ticket,
        repo: state === 'queued' || state === 'planning' ? null : 'example/repo',
        briefPath: null,
        branch: null,
        worktreePath: null,
        base: null,
        state,
        reason: isFirstFailed
          ? 'fix round 1 -- retrying against: missing null check on line 42, unhandled promise rejection'
          : state === 'parked' ? 'blocked on a schema question' : state === 'failed' ? 'launch threw: worktree setup failed' : null,
        runKey: null,
        pr: state === 'review' ? { no: 100 + n, url: `https://example.invalid/pr/${100 + n}`, files: 3, add: 30, del: 4, draft: true } : null,
        journalIds: [],
        createdAt: now - n * 60_000,
        updatedAt: now - n * 30_000,
        fixRoundsUsed: isFirstFailed ? 1 : undefined,
        councilNotes: isFirstReview ? ['needs a regression test for the null-check path', 'add input validation on the new endpoint'] : undefined,
      });
    }
  }
  return out;
}

/** Every integration reporting `ok`, paired with `emptyLanes` for the empty-fleet
 *  scenario -- the seed board's AWS row is deliberately `down` so the default
 *  fixture's needs-you strip has something to show, which would otherwise leak
 *  a plate into a board that is supposed to have nothing needing anyone. */
export function healthyIntegrations(seed: Integration[]): Integration[] {
  return seed.map((i) => ({
    ...i, status: 'ok', since: null, cause: null, effect: null, fix: null, fixLabel: null,
    dependents: [], step: null, retryCount: 0,
  }));
}

/** H2.7: a board shaped like the real one the human-UI work was reported against --
 *  31 lanes, 4 probes, a ticket retried three times, a draft PR in review, a
 *  done-and-merged lane, a killed lane, a lane parked on a question, and a self
 *  item, every lane carrying a title and a plain sentence so H2.1 through H2.6 all
 *  have something real to render against in one place. */
export function humanBoardLanes(): Lane[] {
  const now = Date.now();
  const out: Lane[] = [];

  for (let i = 0; i < 4; i += 1) {
    out.push(lane({
      id: `probe-${i}`, state: i === 3 ? 'blocked' : 'done', kind: 'probe', ticket: null,
      title: 'Live probe of the runner', plain: i === 3 ? 'Probe blocked: the runner never answered.' : `Probe passed at ${new Date(now - i * 3_600_000).toISOString().slice(11, 16)}.`,
      stepText: 'probing', hop: 3, hopStatus: i === 3 ? 'blocked' : 'done',
    }));
  }

  const chainTicket = 'FLT-700';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    out.push(lane({
      id: `chain-${chainTicket}-${attempt}`, ticket: chainTicket, kind: 'chain', attempt,
      state: attempt === 3 ? 'running' : 'blocked',
      title: 'nightly chain: reconcile stale wallet holds',
      plain: attempt === 3 ? 'Working since 08:00 on a Sonnet session, 12 turns in, last did: re-ran the reconciliation job.' : `Blocked since attempt ${attempt}: the reconciliation job failed the gate.`,
      startedAt: now - (4 - attempt) * 3_600_000, heart: attempt === 3,
    }));
  }

  out.push(lane({
    id: 'review-1', ticket: 'FLT-701', kind: 'ticket', state: 'handed-off', hop: 3,
    title: 'show a spinner while the wallet balance refreshes', sourceUrl: 'https://example.invalid/browse/FLT-701',
    plain: 'Draft PR #119 is open with checks green and the council still reviewing.',
    pr: { no: 119, url: 'https://example.invalid/pr/119', files: 2, add: 41, del: 3, draft: true, checks: 'success', verdict: null, merged: false },
  }));

  out.push(lane({
    id: 'merged-1', ticket: 'FLT-702', kind: 'ticket', state: 'merged', hop: 5, hopStatus: 'done',
    title: 'fix the withdrawal fee rounding error', sourceUrl: 'https://example.invalid/browse/FLT-702',
    plain: 'Merged into develop at 20:27; dev OTA ios=update android=update.',
    pr: { no: 120, url: 'https://example.invalid/pr/120', files: 3, add: 18, del: 2, draft: false, checks: 'success', verdict: 'PASS', merged: true },
  }));

  out.push(lane({
    id: 'killed-1', ticket: 'FLT-703', kind: 'ticket', state: 'killed',
    title: 'add a retry to the Plaid webhook', sourceUrl: 'https://example.invalid/browse/FLT-703',
    plain: 'Stopped by you at 12:48 (duplicate of FLT-701).',
  }));

  out.push(lane({
    id: 'parked-1', ticket: 'FLT-704', kind: 'ticket', state: 'parked',
    title: 'the migration column should be NOT NULL or nullable', sourceUrl: 'https://example.invalid/browse/FLT-704',
    plain: 'Asking: the migration column should be NOT NULL or nullable with a backfill job?',
    question: { key: 'ask-704', text: 'the migration column should be NOT NULL or nullable with a backfill job?', opts: ['NOT NULL', 'nullable + backfill'], askedAt: now },
  }));

  out.push(lane({
    id: 'unread-pr-1', ticket: 'FLT-706', kind: 'ticket', state: 'done',
    title: 'wire the retry backoff into the sync job', sourceUrl: 'https://example.invalid/browse/FLT-706',
    plain: 'Draft PR #121 is open; the queue never merges on its own, so it is waiting for your Merge.',
    pr: { no: 121, url: 'https://example.invalid/pr/121', draft: true },
  }));

  out.push(lane({
    // 2026-09-08: a 40-char sha, uncut, and a 90-char title -- the tile geometry
    // e2e specs need a fixture that actually overflows a tile to bite on.
    id: 'long-title-1', ticket: 'FLT-705', kind: 'ticket', state: 'running',
    title: 'the withdrawal fee rounds down instead of to the nearest cent on every payout over five hundred dollars, which the finance team flagged after last week\'s reconciliation',
    sourceUrl: 'https://example.invalid/browse/FLT-705',
    plain: 'Working since 09:10 on a Sonnet session, 6 turns in, last did: fixed 7e57ca8958472653575ea6d29c7003526c3ec723 in the fee calculator.',
  }));

  out.push(lane({
    id: 'stale-ask-1', ticket: 'FLT-707', kind: 'ticket', state: 'parked',
    title: 'clean up the orphaned webhook subscriptions', sourceUrl: 'https://example.invalid/browse/FLT-707',
    plain: 'Parked, waiting on you.',
    question: { key: 'ask-707', text: '', opts: [], askedAt: now - 30 * 3_600_000 },
  }));

  out.push(lane({
    id: 'self-1', kind: 'self', ticket: null, state: 'blocked',
    title: 'self finding: the queue worker leaks a file handle on retry',
    plain: 'Self-analysis found a leaked file handle; blocked on your review.',
  }));

  const fillerKinds: Lane['kind'][] = ['ticket', 'hotfix', 'brief', 'manual'];
  const fillerStates: Lane['state'][] = ['running', 'paused', 'blocked', 'done', 'exhausted', 'unverified'];
  const fillerCount = 31 - out.length;
  for (let i = 0; i < fillerCount; i += 1) {
    const kind = fillerKinds[i % fillerKinds.length] as Lane['kind'];
    const state = fillerStates[i % fillerStates.length] as Lane['state'];
    const ticket = kind === 'manual' ? null : `FLT-${800 + i}`;
    out.push(lane({
      id: `filler-${i}`, ticket, kind, state,
      title: `board item ${i}: a plain one-line title`,
      plain: `Working on board item ${i}, last did: ran the suite.`,
      sourceUrl: ticket ? `https://example.invalid/browse/${ticket}` : null,
    }));
  }

  return out;
}

/** Empty proposal list, paired with `emptyLanes` for the empty-fleet scenario --
 *  a rule pointing at `mergedToday`/`fails` figures a fleet with nothing running
 *  can't honestly have. */
export function emptyRules(): Rule[] {
  return [];
}

/** A run thread far taller than any screen, on the seed board's first lane: the
 *  ticket sheet must stay inside the viewport and scroll the thread within itself. */
export function longThread(): Message[] {
  const now = Date.now();
  const messages: Message[] = [];
  for (let i = 0; i < 80; i += 1) {
    messages.push({
      k: `long-${i}`, type: 'event', text: `Turn ${i + 1}: edited a file and ran the unit suite`,
      ts: now - (80 - i) * 30_000, source: 'system', lane: 'FLT-201', verifiedAt: now - (80 - i) * 30_000,
    });
  }
  return messages;
}

/**
 * The stub board `scripts/design-parity.ts` photographs: one lane in every state the
 * design draws, two open questions, a ready PR, three blockers with different owners,
 * a queue with an `after:` hold, and a rail carrying every card kind (question,
 * confirm, blocker, decision, tools). Fictional project, fictional people. Nothing
 * here ships in the console; the stub server serves it under
 * `POST /__test/fixture?name=design-parity`.
 */
import type { Blocker, Lane, Message, QueueItem } from '../../shared/console-model.js';
import { registers, verbatim } from './narrated.js';
import { computeYou } from '../../forge/console/laneGlance.js';

function lane(partial: Partial<Lane> & Pick<Lane, 'id' | 'state' | 'since'>): Lane {
  const now = Date.now();
  const built: Lane = {
    ticket: partial.id, title: null, kind: 'ticket', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    did: null, didVerbatim: false, now: '', you: null, model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement', repo: 'northwind/rewards',
    attempt: 1, reason: null, stepN: 2, stepTotal: 6, stepText: 'working', ctxTokens: 40_000, ctxCeiling: 200_000, ctxCompactAt: 180_000,
    tokens: 240_000, tokenCap: 4_000_000, tokensPerMin: 0, fails: 0, hop: 2, hopStatus: 'live', observedAt: now, verifiedAt: now,
    heart: true, startedAt: partial.since, endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false,
    needsAaron: null, live: { alive: false, pid: null, lastEventAt: null, checkedAt: now },
    ...partial,
  };
  if (partial.now === undefined) built.now = built.plain;
  if (partial.you === undefined) built.you = computeYou(built);
  return built;
}

export function parityLanes(): Lane[] {
  const now = Date.now();
  const m = (minutes: number): number => now - minutes * 60_000;
  return [
    lane({ id: 'NWR-182', state: 'running', since: m(14), title: 'Show pending withdrawals on the ledger', plain: 'Writing the ledger query and its test.', heart: true, live: { alive: true, pid: 4411, lastEventAt: now, checkedAt: now }, sandbox: { id: 'wt-182', path: null, branch: 'feature/nwr-182', pid: 4411, sessionId: null, region: 'local', instanceType: null } }),
    lane({ id: 'NWR-226', state: 'parked', since: m(9), title: 'Rate-limit the odds refresh endpoint', plain: 'Asked you: limit per user or per IP? Paused until you answer.', heart: false,
      question: { key: 'ask-nwr-226', text: 'Should I limit the odds refresh per user or per IP address?', opts: ['Per user, the way bet placement and deposits already work', 'Per IP address, so anonymous callers are covered too', 'Both: per user when logged in, per IP otherwise'], askedAt: m(9) } }),
    lane({ id: 'NWR-96', state: 'done', since: m(3), title: 'Fix duplicate deposit rows after retry', plain: 'Checks passed and the council approved PR #412.', heart: false, hop: 4, hopStatus: 'done',
      pr: { no: 412, url: 'https://example.invalid/northwind/rewards/pull/412', files: 3, add: 48, del: 12, draft: false, checks: 'success', verdict: 'PASS', merged: false }, mergeable: { ok: true } }),
    lane({ id: 'NWR-178', state: 'blocked', since: m(41), title: 'Add Sentry breadcrumbs to the bet slip', plain: 'Cannot read the Sentry project; the token expired.', heart: true, reason: 'blocked on integration:sentry', blockedBy: 'sentry' }),
    lane({ id: 'NWR-60', state: 'parked', since: m(2), title: 'Migrate sessions table to Postgres 16', plain: 'Asked you: run the 40-second table lock on dev now?', heart: false,
      question: { key: 'ask-nwr-60', text: 'The migration locks the sessions table for about 40 seconds on dev. Run it now?', opts: ['Run it now; dev is quiet and QA is not testing', 'Run it after 18:00 when the QA session ends', 'Avoid the lock: build the index concurrently and migrate in two steps'], askedAt: m(2) } }),
    lane({ id: 'NWR-202', state: 'blocked', since: m(6), title: 'Export monthly statement as CSV', plain: 'Waiting on CI; GitHub Actions minutes are used up.', heart: false, reason: 'checks refused: billing', pr: { no: 418, url: 'https://example.invalid/northwind/rewards/pull/418', draft: true, checks: 'failure' } }),
    lane({ id: 'NWR-141', state: 'parked', since: m(72), title: 'Nightly reconciliation job times out', plain: 'Parked until Dana grants CloudWatch read access.', heart: false, reason: 'needs CloudWatch read access on the reconciliation log group' }),
    lane({ id: 'NWR-77', state: 'merged', since: m(89), endedAt: m(89), title: 'Dark mode for the bankroll chart', plain: 'Merged.', heart: false, hop: 5, hopStatus: 'done', pr: { no: 401, url: 'https://example.invalid/northwind/rewards/pull/401', draft: false, merged: true, mergedAt: m(89) } }),
    lane({ id: 'NWR-133', state: 'merged', since: m(122), endedAt: m(122), title: 'Round stake to two decimals in the slip', plain: 'Merged.', heart: false, hop: 5, hopStatus: 'done', pr: { no: 396, url: 'https://example.invalid/northwind/rewards/pull/396', draft: false, merged: true, mergedAt: m(122) } }),
  ];
}

/** A parity blocker's registers: the card's own sentences at a glance, a fuller reading
 *  of each behind the card's one `more`, and the record each was written from. The title
 *  is verbatim -- it names the thing that broke and no rewording improves it. */
function blockerRegisters(blocker: Blocker): Blocker {
  return {
    ...blocker,
    narration: {
      title: verbatim(blocker.title),
      detail: registers(blocker.detail, `${blocker.detail} ${blocker.blocks.length === 1 ? 'One agent is stopped on it.' : `${blocker.blocks.length} agents are stopped on it.`}`,
        'blocker.detail', { kind: blocker.kind, blocks: blocker.blocks.length }),
      howToResolve: registers(blocker.howToResolve, `${blocker.howToResolve} ${blocker.youCanResolve ? 'You can do it yourself, now.' : 'It is not yours to do.'}`,
        'blocker.howToResolve', { kind: blocker.kind, you: blocker.youCanResolve }),
      thenWhat: registers(blocker.thenWhat, `${blocker.thenWhat} Nothing else has to be restarted by hand.`,
        'blocker.thenWhat', { kind: blocker.kind, blocks: blocker.blocks.length }),
      ...(blocker.whoNote ? { whoNote: verbatim(blocker.whoNote) } : {}),
    },
  };
}

export function parityBlockers(): Blocker[] {
  const now = Date.now();
  const m = (minutes: number): number => now - minutes * 60_000;
  // Annotated rather than inferred: an array literal widens `kind` to `string`, and these
  // rows have to be `Blocker`s before `blockerRegisters` can narrate them.
  const rows: Blocker[] = [
    { id: 'integration:sentry', kind: 'integration', title: 'The Sentry token expired', detail: 'Sentry stopped answering at the last health check; the token expired.', youCanResolve: true, howToResolve: 'Paste a new token in Settings.', who: 'You', whoNote: 'about a minute', links: [], blocks: [{ laneId: 'NWR-178', label: 'NWR-178' }, { laneId: 'NWR-155', label: 'NWR-155' }], blockedBy: [], state: 'open', since: m(44), checkedAt: null, resolvedAt: null, thenWhat: 'Both tickets resume on their own.', lastCheck: null },
    { id: 'billing:northwind/rewards', kind: 'billing', title: 'GitHub Actions minutes are used up for the month', detail: 'The checks on PR #418 were refused: the spending limit is reached.', youCanResolve: false, howToResolve: 'Someone buys more minutes or raises the plan.', who: 'GitHub billing', whoNote: 'outside vendor; you hold the card', links: [{ label: 'GitHub billing settings', url: 'https://github.com/settings/billing' }], blocks: [{ laneId: 'NWR-202', label: 'NWR-202' }], blockedBy: [], state: 'open', since: m(9), checkedAt: null, resolvedAt: null, thenWhat: 'Checks re-run automatically.', lastCheck: null },
    { id: 'owner:cloudwatch', kind: 'owner', title: 'CloudWatch will not let the agent read the reconciliation logs', detail: 'Needs CloudWatch read access on the reconciliation log group.', youCanResolve: false, howToResolve: 'Dana grants read access on the log group.', who: 'Dana', whoNote: 'owns the AWS account', links: [], blocks: [{ laneId: 'NWR-141', label: 'NWR-141' }], blockedBy: [], state: 'open', since: m(135), checkedAt: null, resolvedAt: null, thenWhat: 'The lane resumes once access lands.', lastCheck: null },
    { id: 'integration:jira', kind: 'integration', title: 'Jira rate limit', detail: 'Jira answered 429 for ten minutes.', youCanResolve: true, howToResolve: 'Wait it out.', who: 'You', links: [], blocks: [{ laneId: 'NWR-77', label: 'NWR-77' }], blockedBy: [], state: 'resolved', since: m(170), checkedAt: m(160), resolvedAt: m(160), thenWhat: 'Restarted NWR-77.', lastCheck: 'lifted; restarted NWR-77' },
  ];
  return rows.map(blockerRegisters);
}

export function parityQueue(): QueueItem[] {
  const now = Date.now();
  const q = (id: string, title: string, extra: Partial<QueueItem> = {}): QueueItem => ({
    id: `Q-${id}`, source: 'ticket', input: id, ticket: id, repo: 'northwind/rewards', briefPath: null, branch: null, worktreePath: null, base: null,
    state: 'queued', reason: null, runKey: null, pr: null, journalIds: [], createdAt: now - 30 * 60_000, updatedAt: now, title, ...extra,
    narration: {
      // The title came off a ticket somebody wrote, so it is verbatim: three identical
      // registers and no disclosure, exactly as the real queue route serves it.
      title: verbatim(title),
      ...(extra.whyNext ? { whyNext: registers(extra.whyNext, `${extra.whyNext} Nothing ahead of it is waiting on you.`, 'queue.whyNext', { source: 'ticket' }) } : {}),
      ...(extra.startsIn ? { startsIn: registers(extra.startsIn, `${extra.startsIn}; no one has to start it by hand.`, 'queue.startsIn', { state: extra.state ?? 'queued' }) } : {}),
    },
  });
  return [
    q('NWR-155', 'Alert on failed payouts', { whyNext: 'First in the queue, from a ticket in Ready for Dev; part of the Payouts epic.', startsIn: 'Blocked by Sentry until you fix the token' }),
    q('NWR-119', 'Retry webhook delivery with backoff', { whyNext: 'Second in the queue, from a ticket in Ready for Dev.', startsIn: 'Takes a free slot on the next tick' }),
    q('NWR-233', 'Bankroll chart on the mobile layout', { whyNext: 'Third in the queue, from a ticket in Ready for Dev.', startsIn: 'When the next slot frees' }),
    q('NWR-240', 'Rename "stake" to "wager" across the API', { after: ['nwr-233'], whyNext: '4th in the queue, from a ticket in Ready for Dev. Its brief says to wait for nwr-233.', startsIn: 'After nwr-233 finishes' }),
    q('NWR-251', 'Weekly deposit limit reminders', { whyNext: '5th in the queue, from a ticket in Ready for Dev.', startsIn: 'After 2 more finish' }),
    q('NWR-96', 'Fix duplicate deposit rows after retry', { state: 'review', handoffAt: now - 3 * 60_000, pr: { no: 412, url: 'https://example.invalid/northwind/rewards/pull/412', draft: false } }),
  ];
}

export function parityThread(): Message[] {
  const now = Date.now();
  const m = (minutes: number): number => now - minutes * 60_000;
  return [
    { k: 'p1', type: 'reply', text: 'NWR-96 passed checks and the council approved PR #412. It is ready for you to merge.', ts: m(16), source: 'conductor' },
    { k: 'p2', type: 'activity', text: '3 tool calls', tools: ['Read PR #412 checks', 'Read council attestation', 'Read Jira NWR-96'], ts: m(16), source: 'conductor',
      narration: { text: registers('3 tool calls', 'Three tool calls: the checks on PR #412, the council attestation, and the ticket.', 'rail.activity', { calls: 3 }) } },
    { k: 'p3', type: 'question', text: 'Should I limit the odds refresh per user or per IP address?', ts: m(9), source: 'NWR-226', lane: 'NWR-226', askKey: 'ask-nwr-226', opts: ['Per user, the way bet placement and deposits already work', 'Per IP address, so anonymous callers are covered too', 'Both: per user when logged in, per IP otherwise'] },
    { k: 'p4', type: 'blocker', text: 'the Sentry token expired', ts: m(5), source: 'NWR-178', lane: 'NWR-178', kicker: 'Blocked · NWR-178 · 41 min', title: 'NWR-178 cannot reach Sentry. What should it do?', body: 'The breadcrumbs step needs to read the Sentry project. Everything else in the ticket is done and tested. NWR-155, next in the queue, needs Sentry too.', btns: [{ label: 'Open Blockers and clear it', cmd: 'open blockers', cls: 'answer' }, { label: 'Tell the agent what to do instead', cmd: 'open lane NWR-178' }] },
    { k: 'p6', type: 'decision', text: 'Webhook retries back off exponentially and stop after five attempts.', ts: m(1), source: 'NWR-119', lane: 'NWR-119', kicker: 'Decided for you · NWR-119 · no reply needed', body: 'The ticket said to retry delivery but not how often. It chose 1, 2, 4, 8 and 16 seconds because the payout provider asks for under a minute in total. One line to change.', btns: [{ label: 'Fine', cmd: 'dismiss parity-decision', cls: 'go' }, { label: 'Change it', cmd: 'open lane NWR-119' }] },
    { k: 'p7', type: 'reply', text: 'NWR-60 asked whether to run a 40-second table lock on dev. It is paused until you answer.', ts: m(1), source: 'conductor' },
  ];
}

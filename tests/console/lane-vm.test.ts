import { describe, expect, it } from 'vitest';

import {
  collapseWardenEvents, costClass, costTip, groupLanesByTicket, kindLabel, laneCta, laneHeadline, mergeableWhy,
  plainLine, prSummaryParts, stepDisplay, tileCapText, tileHeadlineParts,
} from '../../src/console/laneVM.js';
import type { Lane, LaneState, Message } from '../../src/shared/console-model.js';

function lane(state: LaneState, extra: Partial<Lane> = {}): Lane {
  return {
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'FLT-1', ticket: 'FLT-1', model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-api', attempt: 1, state, reason: null, stepN: 1, stepTotal: 6, stepText: '',
    ctxTokens: 1000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 1, tokenCap: 10, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: 0, verifiedAt: 0, heart: false, since: 0, startedAt: 0,
    endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null, runaway: false, needsAaron: null,
    ...extra,
  };
}

// HANDOFF "Board": exactly one CTA per lane state.
describe('laneCta', () => {
  const cases: Array<[LaneState, string]> = [
    ['running', 'Watch live'],
    ['parked', 'Answer →'],
    ['handed-off', 'View council'],
    ['paused', 'Resume ▶'],
    ['done', 'Merge now →'],
    ['exhausted', 'Compact + resume →'],
    ['unverified', 'Verify →'],
    ['merged', 'Open PR ↗'],
    ['killed', 'Reopen'],
  ];

  it.each(cases)('renders the one CTA the HANDOFF names for %s', (state, label) => {
    expect(laneCta(lane(state)).label).toBe(label);
  });

  it('a runaway running lane offers Kill attempt instead of Watch live', () => {
    expect(laneCta(lane('running', { runaway: true })).label).toBe('Kill attempt');
    expect(laneCta(lane('running', { runaway: true })).cls).toBe('btnR');
  });

  it('a blocked lane offers the gate log by default', () => {
    expect(laneCta(lane('blocked')).label).toBe('Gate log →');
  });

  it('a lane blocked on an integration offers reconnect instead', () => {
    expect(laneCta(lane('blocked', { blockedBy: 'aws' })).label).toBe('Reconnect AWS →');
  });

  // H2.1: `mergeable` governs whether a done lane's CTA is allowed to be Merge.
  it('a done lane with mergeable ok:true still offers Merge now', () => {
    expect(laneCta(lane('done', { mergeable: { ok: true } })).label).toBe('Merge now →');
  });

  it('a done lane with mergeable ok:false never offers a Merge button', () => {
    const cta = laneCta(lane('done', { mergeable: { ok: false, why: 'checks are still running' } }));
    expect(cta.label).not.toMatch(/merge/i);
  });

  it('a done lane with no mergeable info at all still offers Merge now (unknown reads as fine here)', () => {
    expect(laneCta(lane('done', { mergeable: null })).label).toBe('Merge now →');
  });
});

describe('mergeableWhy', () => {
  it('is null for a done lane with no mergeable info or an ok mergeable', () => {
    expect(mergeableWhy(lane('done', { mergeable: null }))).toBeNull();
    expect(mergeableWhy(lane('done', { mergeable: { ok: true } }))).toBeNull();
  });

  it('surfaces the why for a done lane that is not mergeable', () => {
    expect(mergeableWhy(lane('done', { mergeable: { ok: false, why: 'checks are still running' } }))).toBe('checks are still running');
  });

  it('is null for a lane not in the done state, whatever mergeable says', () => {
    expect(mergeableWhy(lane('running', { mergeable: { ok: false, why: 'checks are still running' } }))).toBeNull();
  });
});

// POLISH-1 #1: the tile prefixes the step text with `step N/M · ` once the lane has a step total.
describe('stepDisplay', () => {
  it('prefixes the step text with step N/M when the lane has a step total', () => {
    expect(stepDisplay(lane('running', { stepN: 2, stepTotal: 9, stepText: 'retry loop' }))).toBe('step 2/9 · retry loop');
  });

  it('prints the step text bare when there is no step total', () => {
    expect(stepDisplay(lane('blocked', { stepN: 0, stepTotal: 0, stepText: 'cannot provision' }))).toBe('cannot provision');
  });
});

// POLISH-1 #2, corrected: the tile shows the cap once cost exceeds it, whether or not
// the lane also carries the separate `runaway` flag (prototype: `over=l.cost>l.cap`,
// used unconditionally).
describe('tileCapText / costClass', () => {
  it('shows no cap text on a normal tile', () => {
    expect(tileCapText(lane('running', { tokens: 864_000, tokenCap: 4_000_000, runaway: false }))).toBe('');
  });

  it('shows cap Nk/M tokens · ×K once tokens exceed the cap, even without the runaway flag', () => {
    expect(tileCapText(lane('running', { tokens: 5_500_000, tokenCap: 1_600_000, runaway: false }))).toBe('cap 1.6M tokens · ×3');
  });

  it('shows the same cap text for a runaway lane', () => {
    expect(tileCapText(lane('running', { tokens: 5_500_000, tokenCap: 1_600_000, runaway: true }))).toBe('cap 1.6M tokens · ×3');
  });

  it('renders the cost readout phosphor-off when stale, regardless of amount', () => {
    expect(costClass(lane('running', { tokens: 5_500_000, tokenCap: 1_600_000 }), true)).toBe('ws');
    expect(costClass(lane('running', { tokens: 5_500_000, tokenCap: 1_600_000 }), false)).toBe('w2');
  });

  it('reads amber past 1,000,000 tokens with no cap set at all', () => {
    expect(costClass(lane('running', { tokens: 1_200_000, tokenCap: null }))).toBe('w1');
    expect(costClass(lane('running', { tokens: 900_000, tokenCap: null }))).toBe('w0');
  });
});

// Final fidelity sweep #1: a ticket outranks the run id as the headline, and the
// headline is always exactly one line -- the run id lives only in `runId`, for a
// `title` attribute, never as a second visible line. The tile, the ticket sheet
// band and the needs-you plates all read it off this one function.
describe('laneHeadline', () => {
  it('heads with the run id when there is no ticket', () => {
    expect(laneHeadline(lane('running', { ticket: null, id: 'jira_AB-12_1788460932645' }))).toEqual({ main: 'jira_AB-12_1788460932645', runId: 'jira_AB-12_1788460932645' });
  });

  it('heads with the ticket and still carries the full run id for the title attribute', () => {
    expect(laneHeadline(lane('running', { ticket: 'AB-12', id: 'jira_AB-12_1788460932645' }))).toEqual({ main: 'AB-12', runId: 'jira_AB-12_1788460932645' });
  });

  it('carries the same value for main and runId when the ticket is just the run id under another name', () => {
    expect(laneHeadline(lane('running', { ticket: 'FLT-1', id: 'FLT-1' }))).toEqual({ main: 'FLT-1', runId: 'FLT-1' });
  });
});

// H2.1: the tile headline bolds the ticket key and shows the title beside it; a lane
// with no key shows the title alone; the run id never appears as text.
describe('tileHeadlineParts', () => {
  it('carries key and title separately when both are set', () => {
    expect(tileHeadlineParts(lane('running', { ticket: 'FLT-9', title: 'the withdrawal fee is off by one', id: 'run-1' })))
      .toEqual({ key: 'FLT-9', title: 'the withdrawal fee is off by one', runId: 'run-1' });
  });

  it('has no key when the lane carries no ticket', () => {
    expect(tileHeadlineParts(lane('running', { ticket: null, title: 'Live probe of the runner', id: 'probe-1' })).key).toBeNull();
  });

  it('has no title when the server has not filled one in yet', () => {
    expect(tileHeadlineParts(lane('running', { ticket: 'FLT-9', title: null, id: 'run-1' })).title).toBeNull();
  });
});

describe('kindLabel', () => {
  it('names every lane kind the board can show', () => {
    expect(kindLabel('ticket')).toBe('ticket');
    expect(kindLabel('hotfix')).toBe('hotfix');
    expect(kindLabel('brief')).toBe('brief');
    expect(kindLabel('self')).toBe('self');
    expect(kindLabel('chain')).toBe('chain');
    expect(kindLabel('probe')).toBe('probe');
    expect(kindLabel('manual')).toBe('manual');
  });
});

describe('plainLine', () => {
  it('shows the server plain sentence when the lane carries one', () => {
    expect(plainLine(lane('running', { plain: 'Working since 12:44 on a Sonnet session, 43 turns in, last did: ran tests.' })))
      .toBe('Working since 12:44 on a Sonnet session, 43 turns in, last did: ran tests.');
  });

  it('falls back to the step display when the server has not filled plain in yet', () => {
    expect(plainLine(lane('running', { plain: '', stepN: 2, stepTotal: 9, stepText: 'retry loop' }))).toBe('step 2/9 · retry loop');
  });
});

describe('prSummaryParts', () => {
  it('lays out the pr summary line pieces in order, with the number kept separate for a link', () => {
    const pr = { no: 119, url: 'https://example.invalid/pr/119', files: 2, add: 41, del: 3, draft: true, checks: 'success' as const, verdict: 'PASS WITH NOTES', merged: false };
    expect(prSummaryParts(pr)).toEqual({
      no: 119,
      url: 'https://example.invalid/pr/119',
      rest: 'draft · checks ✓ · council PASS WITH NOTES · 2 files +41 −3',
    });
  });

  it('omits the council segment when there is no verdict yet', () => {
    const pr = { no: 5, url: 'https://example.invalid/pr/5', files: 1, add: 1, del: 0, draft: false, checks: 'pending' as const, verdict: null, merged: false };
    expect(prSummaryParts(pr).rest).toBe('open · checks running · 1 files +1 −0');
  });

  // H1.3 fix: a PR the board has never actually read (queue-sourced, no /run/:id/pr
  // detail fetched yet) carries no `checks`/`files`/`add`/`del` at all -- never a
  // guessed 0, and never the word "pending", which means something different (the
  // board DID read it, and CI is still running).
  it('says checks not read yet, and drops the diff segment entirely, for a PR with no checks and no file counts', () => {
    const pr = { no: 119, url: 'https://example.invalid/pr/119', draft: true, merged: false, verdict: null };
    expect(prSummaryParts(pr).rest).toBe('draft · checks not read yet');
    expect(prSummaryParts(pr).rest).not.toMatch(/files/);
    expect(prSummaryParts(pr).rest).not.toContain('0 files');
  });

  // Sweep #17: BBZ-99, live, reported files/add/del all as 0 on a merged PR --
  // printed as "0 files +0 -0" as if that were a read diff. A merged PR gets the
  // word "merged" instead, and never the diff segment at all.
  it('says merged, never a zero diff, once the PR has merged', () => {
    const pr = { no: 99, url: 'https://example.invalid/pr/99', files: 0, add: 0, del: 0, draft: false, checks: 'success' as const, verdict: 'PASS', merged: true };
    expect(prSummaryParts(pr).rest).toBe('open · checks ✓ · council PASS · merged');
    expect(prSummaryParts(pr).rest).not.toContain('0 files');
  });

  it('drops the diff segment for an all-zero reading even when not merged, treating it as unread', () => {
    const pr = { no: 100, url: 'https://example.invalid/pr/100', files: 0, add: 0, del: 0, draft: true, checks: 'pending' as const, verdict: null, merged: false };
    expect(prSummaryParts(pr).rest).toBe('draft · checks running');
    expect(prSummaryParts(pr).rest).not.toContain('0 files');
  });
});

// H2.2
describe('groupLanesByTicket', () => {
  it('folds three attempts of the same ticket into one group, newest first', () => {
    const groups = groupLanesByTicket([
      lane('blocked', { id: 'r1', ticket: 'FLT-9', attempt: 1, startedAt: 1 }),
      lane('blocked', { id: 'r2', ticket: 'FLT-9', attempt: 2, startedAt: 2 }),
      lane('running', { id: 'r3', ticket: 'FLT-9', attempt: 3, startedAt: 3 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.lanes.map((l) => l.id)).toEqual(['r3', 'r2', 'r1']);
  });

  it('never groups two lanes with no ticket, even if their ids collide with nothing else', () => {
    const groups = groupLanesByTicket([lane('running', { id: 'a', ticket: null }), lane('running', { id: 'b', ticket: null })]);
    expect(groups).toHaveLength(2);
  });
});

// H2.5
describe('collapseWardenEvents', () => {
  function ev(k: string, source: string, text = k): Message {
    return { k, type: 'event', text, ts: 0, source };
  }

  it('collapses a run of consecutive warden ticks into one chip with a count', () => {
    const thread = [ev('a', 'system'), ev('w1', 'warden'), ev('w2', 'warden'), ev('w3', 'warden'), ev('b', 'system')];
    const out = collapseWardenEvents(thread);
    expect(out.map((m) => m.text)).toEqual(['a', 'warden ×3', 'b']);
  });

  it('leaves a single warden tick alone -- no chip needed for one', () => {
    const thread = [ev('w1', 'warden')];
    expect(collapseWardenEvents(thread).map((m) => m.text)).toEqual(['w1']);
  });

  it('never merges two warden runs separated by something else', () => {
    const thread = [ev('w1', 'warden'), ev('w2', 'warden'), ev('mid', 'system'), ev('w3', 'warden')];
    const out = collapseWardenEvents(thread);
    expect(out.map((m) => m.text)).toEqual(['warden ×2', 'mid', 'w3']);
  });
});

// POLISH-1 #6: hover cards carry a value, a source and a time, plus the click target.
describe('costTip', () => {
  it('names the value, the source and the click target', () => {
    const l = lane('running', { id: 'FLT-9', tokens: 864_000, tokenCap: 4_000_000 });
    const fresh = { verified: true, at: 1_000, ageMs: 0 };
    const tip = costTip(l, fresh);
    expect(tip.head).toBe('864k tokens');
    expect(tip.body).toContain('864k tokens');
    expect(tip.body).toContain('FLT-9');
    expect(tip.click).toBe('Click → cost sheet');
  });
});

describe('laneCta: mergeability outranks the run state', () => {
  it('offers Merge on an unverified lane whose PR the board knows is ready', async () => {
    const { laneCta } = await import('../../src/console/laneVM.js');
    const lane = {
      id: 'x', state: 'unverified', retiredAt: null, runaway: false,
      mergeable: { ok: true }, pr: { no: 9, url: 'u', files: 1, add: 1, del: 0, draft: true, merged: false },
    } as never;
    expect(laneCta(lane).cmd).toBe('merge');
  });
});

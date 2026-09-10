/**
 * always-on-warden R-54: `TranscriptDrift` reads the literal transcript tail, not just
 * tool names. The falsifier this guards against: a worker whose tool names look
 * innocent (`Edit`, `Bash`) while the actual file paths and commands belong to a repo
 * the brief never named -- `ConformanceDrift` above is structurally blind to that,
 * because it never opens the transcript file at all. The detector is the prompt itself:
 * the specimen's unique, unnamed-repo file path must reach the judge verbatim.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  parseTranscriptVerdict, TranscriptDrift, TRANSCRIPT_TAIL_LINES,
} from '../../src/forge/conformance-drift.js';

const MISSION = 'Fix the checkout flow in the storefront repo so guest checkout works.';
const DOD = '- [ ] Guest checkout completes without an account.';

function judge(verdict: string, reason = 'because'): { text: string } {
  return { text: JSON.stringify({ verdict, reason }) };
}

describe('parseTranscriptVerdict', () => {
  it('parses a clean JSON reply', () => {
    expect(parseTranscriptVerdict('{"verdict":"drifting","reason":"wandered"}'))
      .toEqual({ verdict: 'drifting', reason: 'wandered' });
  });

  it('parses JSON wrapped in prose or fencing', () => {
    expect(parseTranscriptVerdict('Sure, here it is:\n```json\n{"verdict":"off-brief","reason":"wrong repo"}\n```'))
      .toEqual({ verdict: 'off-brief', reason: 'wrong repo' });
  });

  it('fails safe-open to on-brief on unparseable text', () => {
    expect(parseTranscriptVerdict('not json at all').verdict).toBe('on-brief');
  });
});

describe('TranscriptDrift.check', () => {
  it('on-brief: no actuator call, one journal row', async () => {
    const queryFn = vi.fn().mockResolvedValue(judge('on-brief', 'still on the checkout flow'));
    const journal = { append: vi.fn() };
    const nudge = vi.fn();
    const park = vi.fn();
    const drift = new TranscriptDrift({
      reasoner: { provider: 'claude', call: queryFn } as never,
      journal: journal as never,
      actuator: { nudge, park },
    });
    const result = await drift.check('run-1', MISSION, DOD, 'edited src/checkout/guest.ts', 'brief.md');
    expect(result?.verdict).toBe('on-brief');
    expect(nudge).not.toHaveBeenCalled();
    expect(park).not.toHaveBeenCalled();
    expect(journal.append).toHaveBeenCalledTimes(1);
    expect(journal.append).toHaveBeenCalledWith(expect.objectContaining({
      event: 'drift.checked', run: 'run-1', verdict: 'on-brief', cls: 'drift-judge',
    }));
  });

  it('drifting: one nudge, no park, no confirm call', async () => {
    const queryFn = vi.fn().mockResolvedValue(judge('drifting', 'ran npm test in a loop instead of opening a PR'));
    const nudge = vi.fn();
    const park = vi.fn();
    const journal = { append: vi.fn() };
    const drift = new TranscriptDrift({
      reasoner: { provider: 'claude', call: queryFn } as never,
      journal: journal as never,
      actuator: { nudge, park },
    });
    await drift.check('run-2', MISSION, DOD, 'ran npm test\nran npm test\nran npm test', 'brief.md');
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(park).not.toHaveBeenCalled();
    expect(queryFn).toHaveBeenCalledTimes(1); // never spends drift-confirm on "drifting"
  });

  it('off-brief specimen invisible in tool names: the judge is called with the real transcript bytes, confirmed, then parked', async () => {
    // The trap: an edit to a repo the brief never named, filed under an innocent tool
    // name (`Edit`). A checker reading only tool names ("Edit", "Edit", "Bash") would
    // see nothing wrong. The unique path below only exists if the transcript's real
    // bytes reached the judge.
    const UNIQUE_PATH = 'unrelated-side-project/src/totally-different-feature.ts';
    const transcriptTail = [
      `Edit ${UNIQUE_PATH}`,
      `Edit ${UNIQUE_PATH}`,
      'Bash: git commit -m "wip"',
    ].join('\n');

    const queryFn = vi.fn()
      .mockResolvedValueOnce(judge('off-brief', 'editing an unrelated side project'))
      .mockResolvedValueOnce(judge('off-brief', 'confirmed: unrelated-side-project is not this brief'));
    const nudge = vi.fn();
    const park = vi.fn().mockResolvedValue(true);
    const journal = { append: vi.fn() };
    const drift = new TranscriptDrift({
      reasoner: { provider: 'claude', call: queryFn } as never,
      journal: journal as never,
      actuator: { nudge, park },
    });

    const result = await drift.check('run-3', MISSION, DOD, transcriptTail, 'brief.md');

    expect(queryFn).toHaveBeenCalledTimes(2); // judge, then confirm
    // The detector: the judge's actual prompt carries the specimen's unique path.
    const judgeCall = queryFn.mock.calls[0]?.[0] as { className: string; prompt: string };
    expect(judgeCall.className).toBe('drift-judge');
    expect(judgeCall.prompt).toContain(UNIQUE_PATH);
    const confirmCall = queryFn.mock.calls[1]?.[0] as { className: string; prompt: string };
    expect(confirmCall.className).toBe('drift-confirm');
    expect(confirmCall.prompt).toContain(UNIQUE_PATH);

    expect(result?.verdict).toBe('off-brief');
    expect(park).toHaveBeenCalledTimes(1);
    expect(nudge).not.toHaveBeenCalled();
    expect(journal.append).toHaveBeenCalledWith(expect.objectContaining({
      event: 'drift.checked', run: 'run-3', verdict: 'off-brief', cls: 'drift-confirm',
    }));
  });

  it('confirm can walk the verdict back: judge says off-brief, confirm says on-brief -- no park', async () => {
    const queryFn = vi.fn()
      .mockResolvedValueOnce(judge('off-brief', 'looks wrong'))
      .mockResolvedValueOnce(judge('on-brief', 'actually fine, a legitimate dependency edit'));
    const park = vi.fn();
    const drift = new TranscriptDrift({
      reasoner: { provider: 'claude', call: queryFn } as never,
      journal: { append: vi.fn() } as never,
      actuator: { nudge: vi.fn(), park },
    });
    const result = await drift.check('run-4', MISSION, DOD, 'edited node_modules-adjacent config', 'brief.md');
    expect(result?.verdict).toBe('on-brief');
    expect(park).not.toHaveBeenCalled();
  });

  it('a run with no brief is journaled drift.skipped once, and the reasoner is never called', async () => {
    const queryFn = vi.fn();
    const journal = { append: vi.fn() };
    const drift = new TranscriptDrift({
      reasoner: { provider: 'claude', call: queryFn } as never,
      journal: journal as never,
      actuator: { nudge: vi.fn(), park: vi.fn() },
    });
    await drift.check('run-5', undefined, undefined, 'whatever', undefined);
    await drift.check('run-5', undefined, undefined, 'whatever again', undefined);
    expect(queryFn).not.toHaveBeenCalled();
    expect(journal.append).toHaveBeenCalledTimes(1);
    expect(journal.append).toHaveBeenCalledWith(expect.objectContaining({
      event: 'drift.skipped', run: 'run-5', reason: 'no brief',
    }));
  });

  it('privacy: no journal row carries any transcript text, ever', async () => {
    const SECRET_TRANSCRIPT_MARKER = 'super-secret-file-contents-xyz';
    const queryFn = vi.fn().mockResolvedValue(judge('off-brief', 'off task'))
      .mockResolvedValueOnce(judge('off-brief', 'off task'))
      .mockResolvedValueOnce(judge('off-brief', 'confirmed off task'));
    const journal = { append: vi.fn() };
    const drift = new TranscriptDrift({
      reasoner: { provider: 'claude', call: queryFn } as never,
      journal: journal as never,
      actuator: { nudge: vi.fn(), park: vi.fn().mockResolvedValue(true) },
    });
    await drift.check('run-6', MISSION, DOD, SECRET_TRANSCRIPT_MARKER, 'brief.md');
    for (const call of journal.append.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain(SECRET_TRANSCRIPT_MARKER);
    }
  });

  it('TRANSCRIPT_TAIL_LINES is a real positive bound, not a placeholder', () => {
    expect(TRANSCRIPT_TAIL_LINES).toBeGreaterThan(0);
  });
});

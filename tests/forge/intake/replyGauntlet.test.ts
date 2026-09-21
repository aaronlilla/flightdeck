/**
 * The gauntlet loop. Every specimen here is a failure shape measured on the 53 real
 * parked BBZ questions on 2026-09-18, not a hypothetical: the critic rejecting a draft
 * whose claims the thread does not support, the gate refusing before a critic call is
 * spent, and a loop that would otherwise post because a critic answered in a shape
 * nobody could read.
 */
import { describe, expect, it } from 'vitest';

import {
  barSample, critiquePrompt, parseCritique, repairPrompt, runGauntlet,
  type BarComment, type GauntletRound,
} from '../../../src/forge/intake/replyGauntlet.ts';

const BAR: BarComment[] = [
  { ticket: 'BBZ-1', author: 'Haiping Chen', body: 'retested on staging-0bb1889, deposit shows the new balance without a pull to refresh now' },
  { ticket: 'BBZ-2', author: 'Joe Buckley', body: 'closing this out' },
  { ticket: 'BBZ-3', author: 'Harrison', body: 'the BIN rows for the test cards are not in the file, that is why every one of them reads not eligible on the picker' },
];

function round(over: Partial<GauntletRound> = {}): GauntletRound {
  return { round: 1, draft: 'd', verdict: 'ours', supported: true, gap: '', note: '', ...over };
}

describe('runGauntlet', () => {
  it('posts nothing and wins on the first round when the gate and the critic both pass', async () => {
    const result = await runGauntlet({
      build: async () => 'on develop now, promoting Friday',
      critique: async ({ round: r, draft }) => round({ round: r, draft }),
      gate: () => null,
      maxRounds: 3,
    });
    expect(result.won).toBe(true);
    if (result.won) {
      expect(result.reply).toBe('on develop now, promoting Friday');
      expect(result.rounds).toHaveLength(1);
    }
  });

  it('loops until the critic picks ours, feeding the named gap back to the builder', async () => {
    const seen: (string | undefined)[] = [];
    let call = 0;
    const result = await runGauntlet({
      build: async ({ critique }) => { seen.push(critique?.gap); call += 1; return `draft ${call}`; },
      critique: async ({ round: r, draft }) => (r < 3
        ? round({ round: r, draft, verdict: 'theirs', gap: `gap ${r}` })
        : round({ round: r, draft })),
      gate: () => null,
      maxRounds: 5,
    });
    expect(result.won).toBe(true);
    if (result.won) expect(result.reply).toBe('draft 3');
    // The builder saw nothing on round one, then each critic's own gap.
    expect(seen).toEqual([undefined, 'gap 1', 'gap 2']);
  });

  it('never posts when the critic likes the voice but cannot support the claims', async () => {
    const result = await runGauntlet({
      build: async () => 'the fix is on the 09/09 promote',
      critique: async ({ round: r, draft }) => round({
        round: r, draft, verdict: 'ours', supported: false, gap: 'the thread never says which promote carries it',
      }),
      gate: () => null,
      maxRounds: 2,
    });
    expect(result.won).toBe(false);
    if (!result.won) {
      expect(result.reason).toMatch(/did not pick ours within 2 rounds/);
      expect(result.reason).toMatch(/never says which promote/);
      // The work is not thrown away: a person gets the best draft, not an empty row.
      expect(result.bestDraft).toBe('the fix is on the 09/09 promote');
    }
  });

  it('spends no critic call on a draft the comment check would refuse', async () => {
    let critiques = 0;
    const result = await runGauntlet({
      build: async ({ round: r }) => (r === 1 ? 'x'.repeat(50) : 'short and fine'),
      critique: async ({ round: r, draft }) => { critiques += 1; return round({ round: r, draft }); },
      gate: (reply) => (reply.length > 20 ? '161 words of prose, over the 160-word ceiling' : null),
      maxRounds: 3,
    });
    expect(result.won).toBe(true);
    expect(critiques).toBe(1);
    // Round one is recorded as a gate refusal so the journal shows why it took two rounds.
    expect(result.rounds[0]?.note).toMatch(/refused by the comment check/);
    expect(result.rounds[0]?.gap).toMatch(/160-word ceiling/);
  });

  it('defers rather than posting when the critic answers in a shape it cannot read', async () => {
    const result = await runGauntlet({
      build: async () => 'a draft',
      critique: async () => null,
      gate: () => null,
      maxRounds: 3,
    });
    expect(result.won).toBe(false);
    if (!result.won) expect(result.reason).toMatch(/shape the loop cannot read/);
  });

  it('defers when the builder throws or returns nothing', async () => {
    const threw = await runGauntlet({
      build: async () => { throw new Error('model timeout'); },
      critique: async ({ round: r, draft }) => round({ round: r, draft }),
      gate: () => null,
      maxRounds: 3,
    });
    expect(threw.won).toBe(false);
    if (!threw.won) expect(threw.reason).toMatch(/builder failed on round 1: model timeout/);

    const empty = await runGauntlet({
      build: async () => '   ',
      critique: async ({ round: r, draft }) => round({ round: r, draft }),
      gate: () => null,
      maxRounds: 3,
    });
    expect(empty.won).toBe(false);
    if (!empty.won) expect(empty.reason).toMatch(/returned nothing/);
  });

  it('stops at the round cap instead of looping forever', async () => {
    let builds = 0;
    const result = await runGauntlet({
      build: async () => { builds += 1; return 'never good enough'; },
      critique: async ({ round: r, draft }) => round({ round: r, draft, verdict: 'theirs', gap: 'still reads generated' }),
      gate: () => null,
      maxRounds: 4,
    });
    expect(builds).toBe(4);
    expect(result.rounds).toHaveLength(4);
    expect(result.won).toBe(false);
  });
});

describe('parseCritique', () => {
  it('reads the four-line answer', () => {
    const parsed = parseCritique(
      'VERDICT: ours\nSUPPORTED: yes\nGAP: none\nWHY: it answers the question and cites the file',
      2, 'draft',
    );
    expect(parsed).toEqual({ round: 2, draft: 'draft', verdict: 'ours', supported: true, gap: '', note: 'it answers the question and cites the file' });
  });

  it('reads the same fields out of a JSON object', () => {
    const parsed = parseCritique('{"verdict":"theirs","supported":false,"gap":"invents a promote id","why":"nothing backs it"}', 1, 'd');
    expect(parsed?.verdict).toBe('theirs');
    expect(parsed?.supported).toBe(false);
    expect(parsed?.gap).toBe('invents a promote id');
  });

  it('treats a missing or unreadable SUPPORTED as not supported', () => {
    // A critic that forgets the line must not be read as approval.
    expect(parseCritique('VERDICT: ours\nGAP: none', 1, 'd')?.supported).toBe(false);
    expect(parseCritique('VERDICT: ours\nSUPPORTED: probably\nGAP: none', 1, 'd')?.supported).toBe(false);
  });

  it('returns null when there is no readable verdict', () => {
    expect(parseCritique('looks good to me!', 1, 'd')).toBeNull();
    expect(parseCritique('VERDICT: 8/10', 1, 'd')).toBeNull();
  });
});

describe('critiquePrompt', () => {
  const prompt = critiquePrompt({
    draft: 'OUR CANDIDATE TEXT', thread: 'THREAD TEXT', bar: BAR, question: 'QUESTION TEXT',
  });

  it('carries the real comments, the thread and the question', () => {
    expect(prompt).toContain('THREAD TEXT');
    expect(prompt).toContain('QUESTION TEXT');
    expect(prompt).toContain('OUR CANDIDATE TEXT');
    expect(prompt).toContain('the BIN rows for the test cards are not in the file');
  });

  it('never tells the critic which side we wrote', () => {
    expect(prompt).not.toMatch(/our draft|we wrote|our reply|the reply we/i);
  });

  it('asks for a binary verdict and refuses a score', () => {
    expect(prompt).toContain('VERDICT: ours | theirs');
    expect(prompt).toMatch(/Do not score\s+anything out of ten/);
  });

  it('never leaks a bar author name into the prompt', () => {
    // The comparison is blind: a critic that reads "Haiping Chen" picks the human.
    expect(prompt).not.toContain('Haiping');
    expect(prompt).not.toContain('Joe Buckley');
  });
});

describe('barSample', () => {
  it('prefers the longest comments, which are the ones that teach a register', () => {
    const sample = barSample(BAR, 2);
    expect(sample).toHaveLength(2);
    expect(sample.map((c) => c.ticket)).not.toContain('BBZ-2');
  });
});

describe('repairPrompt', () => {
  it('names the gap and says the real comments won when they did', () => {
    const text = repairPrompt(round({ verdict: 'theirs', supported: false, gap: 'credits Joe with a comment Aaron wrote' }));
    expect(text).toContain('credits Joe with a comment Aaron wrote');
    expect(text).toMatch(/read more like a person/);
    expect(text).toMatch(/could not find support in the thread/);
  });

  it('falls back to the note when the critic named no gap', () => {
    expect(repairPrompt(round({ gap: '', note: 'refused by the comment check' }))).toContain('refused by the comment check');
  });
});

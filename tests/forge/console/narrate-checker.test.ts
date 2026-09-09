/**
 * The checker: the one thing standing between a nicer sentence and a wrong fact.
 *
 * Every rejection specimen below is a real failure shape, not an invented one: a PR
 * number dropped, a clock time transposed, a count invented, a state word swapped, a run
 * id leaked. The accepting specimens are the design's own copy against the facts the
 * server would have built it from, so the checker is proven to allow the register Aaron
 * approved as well as to refuse the ones he did not.
 */
import { describe, expect, it } from 'vitest';

import type { NarrationFacts } from '../../../src/shared/console-model.js';
import { checkNarration, protectedTokensIn } from '../../../src/forge/console/narrate-checker.js';

const merged: NarrationFacts = {
  surface: 'lane.did',
  facts: { lane: 'NWR-96', pr: 412, checks: 'passed', state: 'done' },
  template: 'Checks passed and the council approved PR #412.',
};

const queued: NarrationFacts = {
  surface: 'queue.whyNext',
  facts: { position: 3, source: 'Ready for Dev', queuedAt: '09:15' },
  template: 'Third in the queue, from a ticket in Ready for Dev; queued 09:15.',
};

const startsIn: NarrationFacts = {
  surface: 'queue.startsIn',
  facts: { ahead: 2 },
  template: 'After 2 more finish.',
};

const parked: NarrationFacts = {
  surface: 'lane.now',
  facts: { lane: 'NWR-226', state: 'parked', kind: 'question', run: 'S-81782ab668cbbbb3' },
  template: 'Asked you: limit per user or per IP? Paused until you answer.',
};

describe('protectedTokensIn', () => {
  it('reads a ticket key, a PR reference, a clock time and a bare number without overlap', () => {
    expect(protectedTokensIn('NWR-96 is 4th; PR #412 queued 09:15.'))
      .toEqual(['NWR-96', '#412', '09:15', '4']);
  });
});

// The holes a critique of this file found on 2026-09-09. Each one is a shape the console
// actually writes, where the old patterns kept one digit group and let the rest change.
describe('protectedTokensIn holds the whole of a number', () => {
  it('keeps a date whole rather than its year alone', () => {
    expect(protectedTokensIn('resumed on 2026-09-09 at noon')).toEqual(['2026-09-09']);
  });

  it('keeps both ends of a range', () => {
    expect(protectedTokensIn('latency held between 10-20ms')).toEqual(['10', '20']);
  });

  it('keeps a decimal that ends a sentence', () => {
    expect(protectedTokensIn('the fee was 3.14.')).toEqual(['3.14']);
  });

  it('keeps a grouped number whole rather than its thousands and its remainder', () => {
    // `1,234` used to read as `1` and `234`, so a narration saying `1,999` carried `1`
    // and was refused for the wrong reason, and one saying `9,234` carried `234` and was
    // accepted for the wrong reason. Both halves are the same fact; the token is the fact.
    expect(protectedTokensIn('compacted at 1,234 tokens')).toEqual(['1,234']);
    expect(protectedTokensIn('200,000 of 2,000,000')).toEqual(['200,000', '2,000,000']);
  });

  it('still keeps the digits inside a time or a ticket key out of it', () => {
    expect(protectedTokensIn('NWR-96 at 09:15')).toEqual(['NWR-96', '09:15']);
  });
});

describe('the leaked-id rules', () => {
  const factsWith = (template: string): NarrationFacts => ({
    surface: 'lane.did', facts: { lane: 'NWR-96' }, template,
  });

  it('refuses a hyphen-prefixed packet key, which a bare-hex rule used to miss', () => {
    const verdict = checkNarration(factsWith('NWR-96 is waiting on the packet.'), {
      glance: 'NWR-96 is waiting on packet-a1b2c3d4e5f67890123.',
      detail: 'NWR-96 is waiting on packet-a1b2c3d4e5f67890123 to come back.',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.rule).toBe('machine-id');
  });

  it('refuses a process id however it is written', () => {
    const verdict = checkNarration(factsWith('NWR-96 is running.'), {
      glance: 'NWR-96 is running under process id 88213.',
      detail: 'NWR-96 is running under process id 88213 right now.',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.rule).toBe('machine-id');
  });
});

describe('rejections, with the offending token named', () => {
  it('rejects a dropped PR number', () => {
    const verdict = checkNarration(merged, {
      glance: 'Checks passed and the council approved PR #412.',
      detail: 'Every check passed and the council approved the pull request, so NWR-96 is done and ready to merge.',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.token).toBe('412');
    expect(verdict.register).toBe('detail');
    expect(verdict.rule).toBe('missing-token');
  });

  it('rejects a clock time changed from 09:15 to 09:51', () => {
    const verdict = checkNarration(queued, {
      glance: 'Third in the queue, from a ticket in Ready for Dev; queued 09:15.',
      detail: 'It is third in line, picked up from Ready for Dev at 09:51.',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.token).toBe('09:15');
    expect(verdict.register).toBe('detail');
  });

  it('rejects an invented count in glance', () => {
    const verdict = checkNarration(startsIn, {
      glance: 'After 3 more finish.',
      detail: 'Two more runs finish before this one starts.',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.token).toBe('3');
    expect(verdict.register).toBe('glance');
    expect(verdict.rule).toBe('invented-token');
  });

  it('rejects a state word changed from parked to paused', () => {
    const verdict = checkNarration(parked, {
      glance: 'Asked you: limit per user or per IP? Paused until you answer.',
      detail: 'NWR-226 is paused on a question of its own and nothing moves until you answer it.',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.token).toBe('parked');
    expect(verdict.register).toBe('detail');
  });

  it('rejects a leaked run id in either register', () => {
    const verdict = checkNarration(parked, {
      glance: 'S-81782ab668cbbbb3 asked you: limit per user or per IP?',
      detail: 'NWR-226 is parked on a question about the limiter key and nothing moves until you answer.',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.token).toBe('S-81782ab668cbbbb3');
    expect(verdict.register).toBe('glance');
    expect(verdict.rule).toBe('machine-id');
  });

  it("rejects a glance that dropped a token its own template carries", () => {
    // Rule 4, which had no specimen until a critique of this file said so. The facts here
    // carry no `pr`, so rules 2 and 3 have nothing to say: the only thing standing between
    // the operator and a lost PR number is the template's own sentence.
    const composed: NarrationFacts = {
      surface: 'lane.you',
      facts: { lane: 'NWR-96' },
      template: 'Review PR #412 and merge it.',
    };
    const verdict = checkNarration(composed, {
      glance: 'Review the pull request and merge it.',
      detail: 'NWR-96 is waiting on your review before it can merge.',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.token).toBe('#412');
    expect(verdict.register).toBe('glance');
    expect(verdict.rule).toBe('missing-token');
  });

  it('rejects an empty register', () => {
    expect(checkNarration(merged, { glance: '', detail: 'x' }).rule).toBe('empty');
  });
});

describe('the design copy against its own facts', () => {
  const accepted: Array<[string, NarrationFacts, { glance: string; detail: string }]> = [
    ['a merged lane', merged, {
      glance: 'Checks passed and the council approved PR #412.',
      detail: 'Every check on PR #412 passed and the council approved it, so NWR-96 is done and ready to merge.',
    }],
    ['a queued ticket', queued, {
      glance: 'Third in the queue, from a ticket in Ready for Dev; queued 09:15.',
      detail: 'It is third in line, picked up from Ready for Dev at 09:15.',
    }],
    ['a queue wait spelled as a word', startsIn, {
      glance: 'After 2 more finish.',
      detail: 'Two more runs finish before this one starts.',
    }],
    ['a parked lane', parked, {
      glance: 'Asked you: limit per user or per IP? Paused until you answer.',
      detail: 'NWR-226 is parked on its own question about the limiter key, and nothing on it moves until you answer.',
    }],
    ['a Sentry blocker', {
      surface: 'blocker.title',
      facts: { kind: 'integration', integration: 'Sentry', blocks: 'NWR-178, NWR-155', state: 'open' },
      template: 'The Sentry token expired.',
    }, {
      glance: 'The Sentry token expired.',
      detail: 'Sentry stopped answering at the last health check because its token expired; the integration is open and NWR-178 and NWR-155 are both stopped on it.',
    }],
  ];

  for (const [name, facts, candidate] of accepted) {
    it(`accepts ${name}`, () => {
      const verdict = checkNarration(facts, candidate);
      expect(verdict.reason).toBe('accepted');
      expect(verdict.ok).toBe(true);
    });
  }
});

import { describe, expect, it } from 'vitest';

import { completeAskOptions, FALLBACK_OPTION } from '../../src/forge/console/ask-options.js';
import type { Provider, Reasoner } from '../../src/forge/contracts.js';

function fakeReasoner(reply: string | Error): Reasoner {
  return {
    provider: 'claude' as Provider,
    call: async () => {
      if (reply instanceof Error) throw reply;
      return { text: reply };
    },
  };
}

function fakeJournal() {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    append: (row: Record<string, unknown>) => { rows.push(row); return row as never; },
  };
}

describe('completeAskOptions', () => {
  it('drafts four or more options with a recommendation when fewer than four arrive', async () => {
    const journal = fakeJournal();
    const reasoner = fakeReasoner(JSON.stringify({ options: ['A', 'B', 'C', 'D'], recommended: 1 }));
    const result = await completeAskOptions(
      { run: 'r1', question: 'which env?', options: ['A', 'B'] },
      { reasoner, journal },
    );
    expect(result.source).toBe('drafted');
    expect(result.recommended).toBe(1);
    expect(result.options.length).toBeGreaterThanOrEqual(4);
    expect(result.options).toContain(FALLBACK_OPTION);
    expect(result.recommended).toBeLessThan(result.options.indexOf(FALLBACK_OPTION));
    expect(journal.rows.at(-1)).toMatchObject({ event: 'forge.ask.options', source: 'drafted' });
  });

  it('passes five worker options through untouched, plus the fallback, journaled as worker', async () => {
    const journal = fakeJournal();
    const reasoner = fakeReasoner(new Error('should not be called'));
    const workerOptions = ['A', 'B', 'C', 'D', 'E'];
    const result = await completeAskOptions(
      { run: 'r1', question: 'which env?', options: workerOptions, recommended: 2 },
      { reasoner, journal },
    );
    expect(result.source).toBe('worker');
    expect(result.options).toEqual([...workerOptions, FALLBACK_OPTION]);
    expect(result.recommended).toBe(2);
    expect(journal.rows.at(-1)).toMatchObject({ event: 'forge.ask.options', source: 'worker' });
  });

  it('falls back to the original options with no recommendation when the reasoner throws', async () => {
    const journal = fakeJournal();
    const reasoner = fakeReasoner(new Error('reasoner boom'));
    const result = await completeAskOptions(
      { run: 'r1', question: 'which env?', options: ['A', 'B'] },
      { reasoner, journal },
    );
    expect(result.source).toBe('worker');
    expect(result.recommended).toBeNull();
    expect(result.options).toEqual(['A', 'B', FALLBACK_OPTION]);
    expect(journal.rows.at(-1)).toMatchObject({ event: 'forge.ask.options', source: 'worker', recommended: null });
  });
});

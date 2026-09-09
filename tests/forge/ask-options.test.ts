import { describe, expect, it } from 'vitest';

import { completeAskOptions } from '../../src/forge/console/ask-options.js';
import type { Reasoner } from '../../src/forge/contracts.js';
import type { ForgeEvent } from '../../src/forge/journal.js';

function fakeJournal() {
  const rows: Record<string, unknown>[] = [];
  return {
    rows,
    append: (event: Partial<ForgeEvent>) => {
      const row = { id: 'x', seq: rows.length, at: 0, version: 1, event: 'note', actor: 'runner', ...event };
      rows.push(row);
      return row as unknown as ForgeEvent;
    },
  };
}

const FREE_TEXT_OPTION = 'Something else, I will type it';

describe('completeAskOptions', () => {
  it('pads two worker options to four or more, with a recommendation from the reasoner, journaled as drafted', async () => {
    const journal = fakeJournal();
    const reasoner: Reasoner = {
      provider: 'claude',
      call: async () => ({
        text: JSON.stringify({ options: ['staging', 'prod'], recommended: 0 }),
      }),
    };
    const result = await completeAskOptions(
      { question: 'dev or staging?', options: ['dev', 'staging'] },
      { reasoner, journal, run: 'run-1' },
    );
    expect(result.options.length).toBeGreaterThanOrEqual(4);
    expect(result.options.slice(0, 2)).toEqual(['dev', 'staging']);
    expect(result.options.at(-1)).toBe(FREE_TEXT_OPTION);
    expect(result.recommended).not.toBeNull();
    expect(result.options[result.recommended as number]).not.toBe(FREE_TEXT_OPTION);
    expect(result.optionSource).toBe('drafted');
    const row = journal.rows.find((r) => r['event'] === 'forge.ask.options');
    expect(row?.['source']).toBe('drafted');
  });

  it('passes five worker options through untouched, journaled as worker', async () => {
    const journal = fakeJournal();
    const reasoner: Reasoner = {
      provider: 'claude',
      call: async () => { throw new Error('must not be called when the worker already gave enough options'); },
    };
    const options = ['a', 'b', 'c', 'd', 'e'];
    const result = await completeAskOptions(
      { question: 'which one?', options },
      { reasoner, journal, run: 'run-1' },
    );
    expect(result.options.slice(0, 5)).toEqual(options);
    expect(result.options.at(-1)).toBe(FREE_TEXT_OPTION);
    expect(result.optionSource).toBe('worker');
    const row = journal.rows.find((r) => r['event'] === 'forge.ask.options');
    expect(row?.['source']).toBe('worker');
  });

  it('keeps the worker\'s own options and a null recommendation when the reasoner throws', async () => {
    const journal = fakeJournal();
    const reasoner: Reasoner = {
      provider: 'claude',
      call: async () => { throw new Error('reasoner is down'); },
    };
    const result = await completeAskOptions(
      { question: 'dev or staging?', options: ['dev', 'staging'] },
      { reasoner, journal, run: 'run-1' },
    );
    expect(result.options.slice(0, 2)).toEqual(['dev', 'staging']);
    expect(result.options.at(-1)).toBe(FREE_TEXT_OPTION);
    expect(result.recommended).toBeNull();
    expect(result.optionSource).toBe('worker');
    const row = journal.rows.find((r) => r['event'] === 'forge.ask.options');
    expect(row?.['source']).toBe('worker');
    expect(row?.['error']).toBeDefined();
  });

  it('refuses an empty question with no reasoner call and no options built', async () => {
    const journal = fakeJournal();
    const reasoner: Reasoner = {
      provider: 'claude',
      call: async () => { throw new Error('must not be called for an empty question'); },
    };
    await expect(completeAskOptions(
      { question: '', options: [] },
      { reasoner, journal, run: 'run-1' },
    )).rejects.toThrow(/question/i);
    expect(journal.rows).toHaveLength(0);
  });
});

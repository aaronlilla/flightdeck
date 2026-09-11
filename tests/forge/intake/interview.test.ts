/**
 * `intake/interview.ts` against a fake `Reasoner` -- no model call in this file.
 *
 * The fixture below is the falsifier the brief names: every prompt assertion reads a
 * value that exists only in this fixture (the ticket key and the `crash on empty
 * voucher list` fact), so a prompt builder that stops carrying the packet fails here
 * rather than passing on a reasoner that returns the right shape regardless.
 */
import { describe, expect, it } from 'vitest';

import type { Packet, Reasoner } from '../../../src/forge/contracts.ts';
import {
  MAX_QUESTIONS, buildBriefPrompt, buildInterviewPrompt, interview, writeBrief,
} from '../../../src/forge/intake/interview.ts';

const UNIQUE_FACT = 'crash on empty voucher list';

function packet(): Packet {
  return {
    id: 'jira:BBZ-277:100',
    ticket: 'BBZ-277',
    what: UNIQUE_FACT,
    where: 'app/screens/VoucherList.tsx:42',
    evidence: ['jira:BBZ-277:100'],
    confidence: 'low',
    repo: 'unknown',
    blockedBy: [],
    at: 100,
  };
}

function reasonerReturning(payload: unknown, seen: { prompts: string[]; classes: string[] }): Reasoner {
  return {
    provider: 'claude',
    async call(input) {
      seen.prompts.push(input.prompt);
      seen.classes.push(input.className);
      return { text: JSON.stringify(payload) };
    },
  };
}

function question(text: string, answerableBy: string, extra: Record<string, unknown> = {}) {
  return { text, options: ['yes', 'no'], recommended: 0, answerableBy, ...extra };
}

describe('interview', () => {
  it('asks the reasoner on the plan class with a prompt carrying this fixture', async () => {
    const seen = { prompts: [] as string[], classes: [] as string[] };
    const reasoner = reasonerReturning(
      { route: 'frontend', questions: [question('Which list empties first?', 'repo')] },
      seen,
    );
    const result = await interview(packet(), reasoner);

    expect(seen.classes).toEqual(['plan']);
    expect(seen.prompts[0]).toContain('BBZ-277');
    expect(seen.prompts[0]).toContain(UNIQUE_FACT);
    expect(result.route).toBe('frontend');
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]!.answerableBy).toBe('repo');
  });

  it('buildInterviewPrompt carries the packet and demands plain first-person question text', () => {
    const prompt = buildInterviewPrompt(packet());
    expect(prompt).toContain('BBZ-277');
    expect(prompt).toContain(UNIQUE_FACT);
    expect(prompt.toLowerCase()).toContain('first person');
    expect(prompt).toContain(String(MAX_QUESTIONS));
  });

  it('caps the questions at four and journals interview.capped for the ones it drops', async () => {
    const seen = { prompts: [] as string[], classes: [] as string[] };
    const rows: { event: string; [k: string]: unknown }[] = [];
    const reasoner = reasonerReturning(
      {
        route: 'frontend',
        questions: [
          question('one', 'repo'), question('two', 'repo'), question('three', 'aaron'),
          question('four', 'teammate'), question('five', 'aaron'), question('six', 'repo'),
        ],
      },
      seen,
    );

    const result = await interview(packet(), reasoner, { append: (row) => { rows.push(row); } });

    expect(result.questions).toHaveLength(MAX_QUESTIONS);
    expect(result.questions.map((q) => q.text)).toEqual(['one', 'two', 'three', 'four']);
    const capped = rows.filter((row) => row.event === 'interview.capped');
    expect(capped).toHaveLength(1);
    expect(capped[0]!['dropped']).toBe(2);
    expect(capped[0]!['ticket']).toBe('BBZ-277');
  });

  it('defaults a teammate question with no name: backend to Joe, product to Jason', async () => {
    const seen = { prompts: [] as string[], classes: [] as string[] };
    const reasoner = reasonerReturning(
      {
        route: 'frontend',
        questions: [
          question('is the endpoint paged?', 'teammate', { topic: 'backend' }),
          question('do we show zero or hide the row?', 'teammate', { topic: 'product' }),
          question('who owns this?', 'teammate', { who: 'Haiping' }),
        ],
      },
      seen,
    );
    const result = await interview(packet(), reasoner);
    expect(result.questions.map((q) => q.who)).toEqual(['Joe', 'Jason', 'Haiping']);
  });

  it('a packet with no questions returns none, and the route stays frontend', async () => {
    const seen = { prompts: [] as string[], classes: [] as string[] };
    const reasoner = reasonerReturning({ route: 'frontend', questions: [] }, seen);
    const result = await interview(packet(), reasoner);
    expect(result.route).toBe('frontend');
    expect(result.questions).toEqual([]);
  });

  it('a backend-only packet returns the backend route, no questions, and the exact ask', async () => {
    const seen = { prompts: [] as string[], classes: [] as string[] };
    const reasoner = reasonerReturning(
      {
        route: 'backend',
        ask: 'The voucher list endpoint returns null for an empty wallet.',
        questions: [question('should never be raised', 'aaron')],
      },
      seen,
    );
    const result = await interview(packet(), reasoner);
    expect(result.route).toBe('backend');
    expect(result.questions).toEqual([]);
    expect(result.ask).toBe('The voucher list endpoint returns null for an empty wallet.');
  });

  it('a reply that is not JSON raises no questions rather than throwing', async () => {
    const reasoner: Reasoner = { provider: 'claude', async call() { return { text: 'sorry, no' }; } };
    const result = await interview(packet(), reasoner);
    expect(result.route).toBe('frontend');
    expect(result.questions).toEqual([]);
  });
});

describe('writeBrief', () => {
  const answers = [
    { question: 'Which list empties first?', answer: 'the voucher list', answeredBy: 'the repo' },
    { question: 'Do we hide the row?', answer: 'hide it entirely', answeredBy: 'Jason' },
  ];

  it('carries every answer verbatim into the brief prompt, with who gave it', () => {
    const prompt = buildBriefPrompt(packet(), answers);
    for (const entry of answers) {
      expect(prompt).toContain(entry.question);
      expect(prompt).toContain(entry.answer);
      expect(prompt).toContain(entry.answeredBy);
    }
    expect(prompt).toContain('BBZ-277');
    expect(prompt).toContain(UNIQUE_FACT);
    expect(prompt).toContain('## Decisions');
  });

  it('calls the reasoner once on the plan class and returns its brief text', async () => {
    const seen = { prompts: [] as string[], classes: [] as string[] };
    const reasoner: Reasoner = {
      provider: 'claude',
      async call(input) {
        seen.prompts.push(input.prompt);
        seen.classes.push(input.className);
        return { text: '# Goal: stop the crash\n' };
      },
    };
    const brief = await writeBrief(packet(), answers, reasoner);
    expect(seen.classes).toEqual(['plan']);
    expect(seen.prompts).toHaveLength(1);
    expect(seen.prompts[0]).toContain('hide it entirely');
    expect(brief.ticket).toBe('BBZ-277');
    expect(brief.text).toContain('# Goal:');
  });
});

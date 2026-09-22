import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { InboxEntry } from '../../../src/forge/inbox.js';
import {
  ticketAsText,
  parseAutoDecision, readAutonomy, runAutopilot, writeAutonomy, type AutopilotDeps,
} from '../../../src/forge/intake/autopilot.js';
import { LEAVE_OPTION } from '../../../src/forge/intake/jiraFeed.js';

const entry = (over: Partial<InboxEntry>): InboxEntry => ({
  key: 'k1', question: 'q', options: [], kind: 'question', runs: ['jira-feed'], goals: [], asked: 1,
  at: 1, disposition: 'park', ...over,
});

function harness(open: InboxEntry[], replyText: string, over: Partial<AutopilotDeps> = {}) {
  const answered: [string, string][] = [];
  const delivered: string[] = [];
  const worked: string[] = [];
  const retired: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const deps: AutopilotDeps = {
    settings: () => ({ answerAsks: true, autoMerge: true }),
    open: () => open,
    reasoner: { call: vi.fn(async () => ({ text: replyText })) },
    checkouts: () => [],
    operatorName: () => 'Aaron Lilla',
    answer: (key, text) => { answered.push([key, text]); return { ...open.find((e) => e.key === key)!, answer: text }; },
    deliver: async (e) => { delivered.push(e.key); },
    retire: (key) => { retired.push(key); },
    work: async (ticket) => { worked.push(ticket); },
    journal: { append: (row) => { rows.push(row); } },
    ...over,
  };
  return { deps, answered, delivered, worked, retired, rows };
}

describe('autopilot', () => {
  it('posts a feed reply by answering the ask (the feed posts it on its next pass)', async () => {
    const h = harness([entry({ ticket: 'BBZ-168', options: ['Still blocked on the backend.', LEAVE_OPTION] })],
      'ACTION: answer\nWHY: he asked for status\nANSWER: Still blocked on Joe\'s endpoint, I\'ll pick it up once it lands.');
    const r = await runAutopilot(h.deps);
    expect(r.answered).toEqual(['k1']);
    expect(h.answered).toEqual([['k1', "Still blocked on Joe's endpoint, I'll pick it up once it lands."]]);
    expect(h.delivered).toEqual([]);
    expect(h.rows[0]).toMatchObject({ event: 'autopilot.answered', action: 'answer', ticket: 'BBZ-168' });
  });

  it('stays silent when a reply would be noise', async () => {
    const h = harness([entry({ ticket: 'BBZ-1', options: ['Thanks!', LEAVE_OPTION] })], 'ACTION: silent\nWHY: just an FYI\nANSWER:');
    const r = await runAutopilot(h.deps);
    expect(r.silent).toEqual(['k1']);
    expect(h.answered).toEqual([['k1', LEAVE_OPTION]]);
  });

  it('queues the ticket when the comment asks for a change, and acknowledges it', async () => {
    const h = harness([entry({ ticket: 'BBZ-9' })], 'ACTION: work\nWHY: asks for a code change\nANSWER: On it.');
    const r = await runAutopilot(h.deps);
    expect(r.worked).toEqual(['k1']);
    expect(h.worked).toEqual(['BBZ-9']);
    expect(h.answered).toEqual([['k1', 'On it.']]);
  });

  it('answers a worker question and delivers it to the run', async () => {
    const h = harness([entry({ runs: ['queue-BBZ-2-Q-9'], options: ['A', 'B'], recommended: 1 })], 'ACTION: answer\nWHY: code uses B\nANSWER: B');
    await runAutopilot(h.deps);
    expect(h.answered).toEqual([['k1', 'B']]);
    expect(h.delivered).toEqual(['k1']);
  });

  it('falls back to the draft rather than stopping when the model answers unreadably', async () => {
    const h = harness([entry({ options: ['the draft', LEAVE_OPTION] })], 'I think maybe');
    await runAutopilot(h.deps);
    expect(h.answered).toEqual([['k1', 'the draft']]);
  });

  it('retires a stale worker question instead of answering nothing', async () => {
    const h = harness([entry({ runs: ['gone-run'], stale: true, staleReason: 'no run' })], '');
    const r = await runAutopilot(h.deps);
    expect(r.retired).toEqual(['k1']);
    expect(h.answered).toEqual([]);
  });

  it('does nothing when switched off', async () => {
    const h = harness([entry({})], 'ACTION: answer\nWHY: x\nANSWER: y', { settings: () => ({ answerAsks: false, autoMerge: true }) });
    expect((await runAutopilot(h.deps)).answered).toEqual([]);
    expect(h.answered).toEqual([]);
  });

  it('rewords a feed reply the comment check would refuse, before answering', async () => {
    const h = harness([entry({ ticket: 'BBZ-385' })], '');
    const call = vi.fn()
      .mockResolvedValueOnce({ text: 'ACTION: answer\nWHY: x\nANSWER: I just think we let WorldPay decide.' })
      .mockResolvedValueOnce({ text: 'ACTION: answer\nWHY: x\nANSWER: I think we let WorldPay decide.' });
    h.deps.reasoner = { call };
    await runAutopilot(h.deps);
    expect(call).toHaveBeenCalledTimes(2);
    expect(h.answered).toEqual([['k1', 'I think we let WorldPay decide.']]);
  });

  it('never lets a worker question go silent', () => {
    expect(parseAutoDecision('ACTION: silent\nWHY: x\nANSWER:', false)).toBeNull();
  });
});

describe('autonomy settings', () => {
  it('are on by default and toggle by file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'auto-')), 'autonomy.json');
    expect(readAutonomy(path)).toEqual({ answerAsks: true, autoMerge: true });
    writeAutonomy(path, { autoMerge: false });
    expect(readAutonomy(path)).toEqual({ answerAsks: true, autoMerge: false });
  });

  it('reads the live ticket into the prompt before deciding', async () => {
    const h = harness([entry({ ticket: 'FDTES-20' })], 'ACTION: silent\nWHY: fyi\nANSWER: -');
    const seen: string[] = [];
    h.deps.reasoner = { call: vi.fn(async (req: { prompt: string }) => { seen.push(req.prompt); return { text: 'ACTION: silent\nWHY: fyi\nANSWER: -' }; }) } as never;
    h.deps.ticketText = async (key) => ticketAsText(key, { summary: 'sum', status: 'Backlog', assignee: null, description: 'desc',
      comments: [{ author: 'Haiping Chen', body: 'the real comment text' }] });
    await runAutopilot(h.deps);
    expect(seen[0]).toContain('Comment by Haiping Chen: the real comment text');
  });
});

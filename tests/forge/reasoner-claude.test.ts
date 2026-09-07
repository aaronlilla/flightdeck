/**
 * `ClaudeReasoner`, the `claude` provider behind the `Reasoner` seam (`contracts.ts`).
 *
 * No model is called anywhere in this file: `tests/setup.ts` makes the SDK's real
 * `query` throw, and every specimen below injects its own fake `queryFn` instead,
 * exercised through the same adapter seam (`src/adapter/engine.ts`'s `QueryFn`) the
 * production runner uses -- never through a mock of `ClaudeReasoner` itself.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Options } from '@anthropic-ai/claude-agent-sdk';

import type { QueryFn } from '../../src/adapter/engine.js';
import {
  ClaudeReasoner, CodexReasoner, ReasonerParseError, ReasonerTimeoutError, ReasonerTurnError,
  reasonerFor,
} from '../../src/forge/reasoner-claude.js';
import { Journal, replay } from '../../src/forge/journal.js';
import { modelFor, modelIdFor } from '../../src/forge/policy.js';

let home: string;
let journalPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-reasoner-claude-'));
  journalPath = join(home, 'fleet.jsonl');
});

/** A fake `query`: replies to the one prompt a `ClaudeReasoner` call ever pushes with
 *  a single assistant message (the given text, with usage) followed by a `result`. */
function fakeQuery(text: string, usage = { input: 10, cacheRead: 0, cacheCreation: 0, output: 5 }) {
  const calls: Array<{ options: Options }> = [];
  const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    calls.push({ options: params.options as Options });
    const promptIter = params.prompt as AsyncIterable<unknown>;
    async function* generate() {
      yield {
        type: 'system', subtype: 'init', session_id: 'reasoner-fake-session',
        model: params.options?.model ?? '', cwd: params.options?.cwd ?? '',
        tools: [], slash_commands: [],
      };
      for await (const _pushed of promptIter) {
        yield {
          type: 'assistant', session_id: 'reasoner-fake-session',
          message: {
            model: params.options?.model ?? '',
            content: [{ type: 'text', text }],
            usage: {
              input_tokens: usage.input, cache_read_input_tokens: usage.cacheRead,
              cache_creation_input_tokens: usage.cacheCreation, output_tokens: usage.output,
            },
          },
        };
        yield {
          type: 'result', subtype: 'success', is_error: false, duration_ms: 5,
          total_cost_usd: 0,
        };
        return;
      }
    }
    const gen = generate() as unknown as ReturnType<QueryFn>;
    return gen;
  }) as QueryFn;
  return { fn, calls };
}

/** A fake `query` whose session never produces another message once the prompt lands:
 *  it hangs forever, the way a stalled or unreachable model would. */
function hangingQuery() {
  const calls: Array<{ options: Options }> = [];
  const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    calls.push({ options: params.options as Options });
    async function* generate() {
      yield {
        type: 'system', subtype: 'init', session_id: 'reasoner-hang-session',
        model: params.options?.model ?? '', cwd: params.options?.cwd ?? '',
        tools: [], slash_commands: [],
      };
      await new Promise(() => {});
    }
    return generate() as unknown as ReturnType<QueryFn>;
  }) as QueryFn;
  return { fn, calls };
}

/**
 * A fake `query` whose turn ends on an error subtype (e.g. `error_max_turns`) with no
 * assistant text at all -- the shape a real audit-lens session hit on 2026-09-07 when
 * it opened a tool call mid-turn and burned its one bounded turn on it instead of an
 * answer, so `turn-complete` arrived `isError: true` with nothing to parse.
 */
function errorTurnQuery(subtype: string) {
  const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    const promptIter = params.prompt as AsyncIterable<unknown>;
    async function* generate() {
      yield {
        type: 'system', subtype: 'init', session_id: 'reasoner-error-turn-session',
        model: params.options?.model ?? '', cwd: params.options?.cwd ?? '',
        tools: [], slash_commands: [],
      };
      for await (const _pushed of promptIter) {
        yield { type: 'result', subtype, is_error: true, duration_ms: 5, total_cost_usd: 0 };
        return;
      }
    }
    return generate() as unknown as ReturnType<QueryFn>;
  }) as QueryFn;
  return { fn };
}

/** A clock that fires every scheduled timeout immediately, so the timeout specimen
 *  below proves the budget without waiting on it. */
function instantClock() {
  const setTimeoutFn = ((cb: () => void) => {
    queueMicrotask(cb);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimeoutFn = (() => {}) as typeof clearTimeout;
  return { setTimeoutFn, clearTimeoutFn };
}

describe('ClaudeReasoner', () => {
  it('yields a typed answer and journals one reasoner.call row with usage, on a valid JSON reply', async () => {
    const { fn } = fakeQuery('{"text": "yes, on task"}');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });

    const result = await reasoner.call({ className: 'evaluate', prompt: 'still on task?' });
    journal.close();

    expect(result).toEqual({ text: 'yes, on task' });
    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'reasoner.call');
    expect(row).toBeDefined();
    expect(row?.['provider']).toBe('claude');
    expect(row?.['class']).toBe('evaluate');
    expect(row?.usage).toEqual({ input: 10, cacheRead: 0, cacheCreation: 0, output: 5 });
    expect(row?.['parsed']).toBe(true);
  });

  it('carries the run on the journal row when the caller knows one, item 7 of 2026-09-05', async () => {
    const { fn } = fakeQuery('{"text": "yes, on task"}');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });

    await reasoner.call({ className: 'evaluate', prompt: 'still on task?', run: 'card-network-glow' });
    journal.close();

    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'reasoner.call');
    expect(row?.['run']).toBe('card-network-glow');
  });

  it('leaves run off the journal row when the caller has none to name', async () => {
    const { fn } = fakeQuery('{"text": "yes, on task"}');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });

    await reasoner.call({ className: 'evaluate', prompt: 'still on task?' });
    journal.close();

    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'reasoner.call');
    expect(row?.['run']).toBeUndefined();
  });

  it('rejects with a typed parse error and journals parsed: false, on an invalid JSON reply', async () => {
    const { fn } = fakeQuery('not json at all');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });

    await expect(reasoner.call({ className: 'evaluate', prompt: 'still on task?' }))
      .rejects.toBeInstanceOf(ReasonerParseError);
    journal.close();

    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'reasoner.call');
    expect(row?.['parsed']).toBe(false);
    expect(row?.['raw']).toBe('not json at all');
  });

  it('accepts any well-formed JSON object, deriving text from a "text" field when one is present', async () => {
    const { fn } = fakeQuery('{"answer": "wrong key"}');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });

    const result = await reasoner.call({ className: 'evaluate', prompt: 'still on task?' });
    journal.close();

    expect(result).toEqual({ text: '{"answer":"wrong key"}' });
    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'reasoner.call');
    expect(row?.['parsed']).toBe(true);
  });

  // I17 correction: a live check against a real Haiku produced this exact raw string, a
  // valid JSON object answering the question asked. The old fixed `{text: string}` schema
  // rejected it anyway (parsed: false), though nothing about the reply was malformed. A
  // `Reasoner.call` seam that only ever reads a plain `.text` back has to accept whatever
  // well-formed object shape the model actually returns, deriving `text` from the whole
  // object when no `text` field is present.
  it('parses the exact raw reply from the I17 live-check escape ({"ok": true, "word": "surge"})', async () => {
    const { fn } = fakeQuery('{"ok": true, "word": "surge"}');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });

    const result = await reasoner.call({ className: 'evaluate', prompt: 'does "surge" appear?' });
    journal.close();

    expect(result.text).toContain('surge');
    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'reasoner.call');
    expect(row?.['parsed']).toBe(true);
    expect(row?.['raw']).toBe('{"ok": true, "word": "surge"}');
  });

  // I17's acceptance: the raw reply is kept in the journal row whether or not it parsed,
  // capped at 2,000 characters.
  it('keeps the raw reply in the journal row on a successful parse too, capped at 2,000 characters', async () => {
    const longWord = 'x'.repeat(3000);
    const { fn } = fakeQuery(`{"text": "${longWord}"}`);
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });

    await reasoner.call({ className: 'evaluate', prompt: 'x' });
    journal.close();

    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'reasoner.call');
    expect(row?.['parsed']).toBe(true);
    expect(typeof row?.['raw']).toBe('string');
    expect((row?.['raw'] as string).length).toBe(2000);
  });

  it('still rejects a JSON reply that is not an object (an array or a bare primitive)', async () => {
    const journal = new Journal(journalPath);
    for (const raw of ['["not", "an", "object"]', '"just a string"', '42', 'null']) {
      const { fn } = fakeQuery(raw);
      const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });
      await expect(reasoner.call({ className: 'evaluate', prompt: 'x' }))
        .rejects.toBeInstanceOf(ReasonerParseError);
    }
    journal.close();
  });

  // 2026-09-07 escape: an audit-lens round against real PR #118 journaled `parsed: false`
  // with `raw` an empty string on four of five lens calls. A live repro through this
  // exact class (`ClaudeReasoner.call`) showed why: the session opened a `Bash`/`Read`
  // tool call, burned its one bounded turn on it, and the SDK ended the session on
  // `error_max_turns` with no assistant text at all -- not a reply that failed to parse.
  it('rejects with a typed turn error, not a parse error, when the turn ends with no text and reports its own failure', async () => {
    const { fn } = errorTurnQuery('error_max_turns');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });

    const rejection = expect(reasoner.call({ className: 'audit-lens', prompt: 'x', replyShape: 'array' }))
      .rejects;
    await rejection.toBeInstanceOf(ReasonerTurnError);
    await rejection.toThrow(/error_max_turns/);
    journal.close();

    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'reasoner.call');
    expect(row?.['parsed']).toBe(false);
    expect(row?.['turnSubtype']).toBe('error_max_turns');
  });

  it('times out inside the injected clock\'s budget and journals reasoner.timeout, on a query that never resolves', async () => {
    const { fn } = hangingQuery();
    const { setTimeoutFn, clearTimeoutFn } = instantClock();
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({
      journal, queryFn: fn, existsConfigDir: () => false, setTimeoutFn, clearTimeoutFn,
    });

    await expect(reasoner.call({ className: 'evaluate', prompt: 'still on task?' }))
      .rejects.toBeInstanceOf(ReasonerTimeoutError);
    journal.close();

    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'reasoner.timeout');
    expect(row).toBeDefined();
    expect(row?.['class']).toBe('evaluate');
  });

  it('opens the session on the model policy.ts names for the class, never a copied map', async () => {
    for (const className of ['evaluate', 'audit-lens', 'audit-judge']) {
      const { fn, calls } = fakeQuery('{"text": "ok"}');
      const journal = new Journal(journalPath);
      const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });
      await reasoner.call({ className, prompt: 'x' });
      journal.close();
      expect(calls[0]?.options.model).toBe(modelIdFor(modelFor(className)));
    }
  });

  it('asks for no tools and a single bounded turn', async () => {
    const { fn, calls } = fakeQuery('{"text": "ok"}');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });
    await reasoner.call({ className: 'evaluate', prompt: 'x' });
    journal.close();

    expect(calls[0]?.options.allowedTools).toEqual([]);
    expect(calls[0]?.options.maxTurns).toBe(1);
    expect(calls[0]?.options.permissionMode).toBe('bypassPermissions');
  });

  // 2026-09-07 escape: a live audit-lens call against a real diff opened a Bash/Read
  // tool call under `bypassPermissions`, because `allowedTools: []` only skips a
  // permission prompt -- it never disables a tool the way the reasoner's own doc
  // comment assumed. `tools: []` (engine.ts's own "disable every built-in tool" field)
  // is the one that actually stops the model from reaching a tool at all, regardless of
  // `permissionMode`.
  it('disables every built-in tool outright, not only via the permission allowlist', async () => {
    const { fn, calls } = fakeQuery('{"text": "ok"}');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });
    await reasoner.call({ className: 'evaluate', prompt: 'x' });
    journal.close();

    expect(calls[0]?.options.tools).toEqual([]);
  });

  // I17: a live check against a real Haiku showed a 23,261-token cache creation on a
  // one-line question, meaning the session opened on the SDK's default `claude_code`
  // preset (which loads CLAUDE.md, skills and hooks) rather than a small prompt of this
  // provider's own. `settingSources: []` alone did not stop that: the default preset is
  // chosen whenever `systemPrompt` is left unset, independent of settingSources.
  it('opens on its own system prompt, not the default preset, with no hooks and no MCP servers', async () => {
    const { fn, calls } = fakeQuery('{"text": "ok"}');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });
    await reasoner.call({ className: 'evaluate', prompt: 'x' });
    journal.close();

    const options = calls[0]?.options;
    expect(typeof options?.systemPrompt).toBe('string');
    expect(options?.systemPrompt).toMatch(/json/i);
    expect(options?.settingSources).toEqual([]);
    expect(options?.hooks).toBeUndefined();
    expect(options?.mcpServers).toBeUndefined();
  });

  it('strips the nine inherited names and ANTHROPIC_API_KEY, and pins CLAUDE_CONFIG_DIR', async () => {
    const { fn, calls } = fakeQuery('{"text": "ok"}');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({
      journal, queryFn: fn, existsConfigDir: () => false,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'leaked', ANTHROPIC_API_KEY: 'leaked' },
    });
    await reasoner.call({ className: 'evaluate', prompt: 'x' });
    journal.close();

    const env = calls[0]?.options.env as NodeJS.ProcessEnv;
    expect(env['CLAUDE_CODE_SESSION_ID']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['CLAUDE_CONFIG_DIR']).toBeDefined();
  });
});

describe('ClaudeReasoner: fenced and array replies (I19)', () => {
  it('parses a fenced JSON array against replyShape: "array"', async () => {
    const finding = {
      member: 'scope-conformance', file: 'src/z.ts', line: 9, claim: 'touches unrelated module',
      failureScenario: 'widens the diff past the ticket', severity: 'medium', confidence: 'medium',
    };
    const fenced = '```json\n' + JSON.stringify([finding]) + '\n```';
    const { fn } = fakeQuery(fenced);
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });

    const result = await reasoner.call({ className: 'audit-lens', prompt: 'x', replyShape: 'array' });
    journal.close();

    expect(JSON.parse(result.text)).toEqual([finding]);
  });

  it('a fenced reply still rejects as an array when the caller never asked for one', async () => {
    const fenced = '```json\n[1, 2, 3]\n```';
    const { fn } = fakeQuery(fenced);
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });

    await expect(reasoner.call({ className: 'evaluate', prompt: 'x' }))
      .rejects.toBeInstanceOf(ReasonerParseError);
    journal.close();
  });

  it('a fenced JSON object still parses (no replyShape needed)', async () => {
    const fenced = '```json\n{"text": "on task, still building the fixture"}\n```';
    const { fn } = fakeQuery(fenced);
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });

    const result = await reasoner.call({ className: 'evaluate', prompt: 'x' });
    journal.close();

    expect(result.text).toBe('on task, still building the fixture');
  });

  it('a plain, unfenced JSON array still parses against replyShape: "array"', async () => {
    const { fn } = fakeQuery('[]');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });

    const result = await reasoner.call({ className: 'audit-lens', prompt: 'x', replyShape: 'array' });
    journal.close();

    expect(JSON.parse(result.text)).toEqual([]);
  });

  it('prose (no JSON at all) still rejects with a typed parse error even under replyShape: "array"', async () => {
    const { fn } = fakeQuery('sorry, I cannot find anything wrong with this diff');
    const journal = new Journal(journalPath);
    const reasoner = new ClaudeReasoner({ journal, queryFn: fn, existsConfigDir: () => false });

    await expect(reasoner.call({ className: 'audit-lens', prompt: 'x', replyShape: 'array' }))
      .rejects.toBeInstanceOf(ReasonerParseError);
    journal.close();
  });
});

describe('CodexReasoner', () => {
  it('returns "not configured" without any subprocess', async () => {
    const reasoner = new CodexReasoner();
    await expect(reasoner.call({ className: 'plan', prompt: 'x' })).rejects.toThrow(/not configured/);
  });
});

describe('reasonerFor', () => {
  it('builds a ClaudeReasoner for provider claude and a CodexReasoner for provider codex', () => {
    const journal = new Journal(journalPath);
    expect(reasonerFor('claude', { journal }).provider).toBe('claude');
    expect(reasonerFor('codex', { journal })).toBeInstanceOf(CodexReasoner);
    journal.close();
  });
});

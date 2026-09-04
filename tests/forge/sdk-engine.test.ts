/**
 * The production `EngineLike`, driven end to end against a fake `query`.
 *
 * No model is called anywhere in this file (or anywhere in the suite: `tests/setup.ts`
 * makes the SDK's real `query` throw). The fake below stands in for a live session: it
 * captures every call `SdkEngine` makes into it, and answers each pushed prompt with a
 * scripted sequence of assistant messages followed by a `result`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';

import type { QueryFn } from '../../src/adapter/engine.js';
import { INHERITED, Worker } from '../../src/forge/worker.js';
import { replay } from '../../src/forge/journal.js';
import { RunInbox } from '../../src/forge/runinbox.js';
import { Inbox } from '../../src/forge/inbox.js';
import { buildCanUseTool, deliverViaStream, SdkEngine } from '../../src/forge/sdkengine.js';
import { Journal } from '../../src/forge/journal.js';

let home: string;
let journalPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-sdkengine-'));
  journalPath = join(home, 'fleet.jsonl');
  // RunInbox (used directly by several specimens below, and internally by the stream
  // fallback) is not one of SdkEngineDeps's overridable paths -- it always resolves
  // through paths.ts's forgeHome(), which falls back to the real machine's home
  // directory when FORGE_HOME is unset. Without this, every specimen here that touches
  // a RunInbox writes into this machine's actual ~/.forge/runs rather than a temp dir.
  process.env['FORGE_HOME'] = home;
});

interface ScriptedStep {
  text?: string;
  usage?: { input: number; cacheRead: number; cacheCreation: number; output: number };
  /**
   * `isError` defaults to false, matching a tool that ran cleanly. `noResult` skips
   * emitting the `tool_result` message at all, for a specimen that needs a tool call
   * left hanging with no reply.
   */
  toolUse?: { name: string; input?: Record<string, unknown>; isError?: boolean; noResult?: boolean };
}

/**
 * A fake `query`: one script entry per prompt pushed. Each entry becomes the assistant
 * messages for that turn, followed by a `result`, matching how the real SDK answers one
 * exchange in streaming-input mode. A `toolUse` step also emits the `user` message
 * carrying its `tool_result`, the way a real tool call resolves before the turn ends.
 */
function fakeQuery(script: ScriptedStep[][]) {
  const calls: Array<{ options: Options }> = [];
  let index = 0;

  const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    calls.push({ options: params.options as Options });
    const promptIter = params.prompt as AsyncIterable<unknown>;

    async function* generate() {
      yield {
        type: 'system', subtype: 'init', session_id: 'sdk-fake-session',
        model: params.options?.model ?? '', cwd: params.options?.cwd ?? '',
        tools: [], slash_commands: [],
      };
      for await (const _pushed of promptIter) {
        const turn = script[index] ?? [];
        index += 1;
        for (const step of turn) {
          const content: unknown[] = [];
          const toolUseId = `tu-${index}`;
          if (step.text !== undefined) content.push({ type: 'text', text: step.text });
          if (step.toolUse) {
            content.push({
              type: 'tool_use', id: toolUseId, name: step.toolUse.name,
              input: step.toolUse.input ?? {},
            });
          }
          yield {
            type: 'assistant', session_id: 'sdk-fake-session',
            message: {
              model: params.options?.model ?? '',
              content,
              ...(step.usage ? {
                usage: {
                  input_tokens: step.usage.input,
                  cache_read_input_tokens: step.usage.cacheRead,
                  cache_creation_input_tokens: step.usage.cacheCreation,
                  output_tokens: step.usage.output,
                },
              } : {}),
            },
          };
          if (step.toolUse && !step.toolUse.noResult) {
            yield {
              type: 'user', session_id: 'sdk-fake-session',
              message: {
                content: [{
                  type: 'tool_result', tool_use_id: toolUseId,
                  is_error: step.toolUse.isError === true, content: 'ok',
                }],
              },
            };
          }
        }
        yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1 };
        if (index >= script.length) return;
      }
    }
    return generate() as unknown as Query;
  }) as unknown as QueryFn;

  return { fn, calls };
}

const REQUEST = {
  run: 'r1',
  model: 'claude-sonnet-5',
  prompt: '# Goal\n\nDo the thing.\n',
  cwd: join(tmpdir(), 'forge-sdkengine-workspace'),
  maxTurns: 40,
};

function engineFor(fn: QueryFn, overrides: Partial<{ deliverVia: 'hook' | 'stream' }> = {}) {
  return new SdkEngine({
    journalPath, inboxDir: join(home, 'inbox'), gotchasDir: join(home, 'gotchas'),
    queryFn: fn, ...overrides,
  });
}

describe('the options the production engine opens with', () => {
  it('passes model, cwd, permissions, settings, turns and a scrubbed environment', async () => {
    const { fn, calls } = fakeQuery([[{ text: 'ok', usage: { input: 1, cacheRead: 0, cacheCreation: 0, output: 1 } }]]);
    const dirtyEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-nope' };
    for (const name of INHERITED) dirtyEnv[name] = 'inherited';

    const engine = engineFor(fn);
    await engine.run({ ...REQUEST, env: dirtyEnv });

    expect(calls).toHaveLength(1);
    const options = calls[0]!.options;
    expect(options.model).toBe('claude-sonnet-5');
    expect(options.cwd).toBe(REQUEST.cwd);
    expect(options.permissionMode).toBe('bypassPermissions');
    // The SDK denies every tool under bypassPermissions unless this is also set; a worker
    // launched without it can read nothing, run nothing, and has no way to report back.
    expect(options.allowDangerouslySkipPermissions).toBe(true);
    expect(options.settingSources).toEqual(['user', 'project']);
    expect(options.maxTurns).toBe(40);
    for (const name of INHERITED) expect(options.env?.[name]).toBeUndefined();
    expect(options.env?.['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(options.env?.['PATH']).toBe('/usr/bin');
  });

  it('records the request it started with', async () => {
    const { fn } = fakeQuery([[{ text: 'ok' }]]);
    const engine = engineFor(fn);
    await engine.run({ ...REQUEST, env: { PATH: '/usr/bin' } });
    expect(engine.started).toHaveLength(1);
    expect(engine.started[0]?.prompt).toBe(REQUEST.prompt);
  });
});

describe('registering the forge tools', () => {
  it('exposes forge_done, forge_handoff, forge_ask, forge_gotcha and forge_report', async () => {
    const { fn, calls } = fakeQuery([[{ text: 'ok' }]]);
    const engine = engineFor(fn);
    await engine.run({ ...REQUEST, env: { PATH: '/usr/bin' } });

    const forgeServer = calls[0]!.options.mcpServers?.['forge'] as unknown as
      { instance: { _registeredTools: Record<string, unknown> } };
    const names = Object.keys(forgeServer.instance._registeredTools).map((name) => `mcp__forge__${name}`);
    expect(names.sort()).toEqual([
      'mcp__forge__forge_ask', 'mcp__forge__forge_done', 'mcp__forge__forge_gotcha',
      'mcp__forge__forge_handoff', 'mcp__forge__forge_report',
    ]);
  });
});

describe('the falsifier: the fake must actually be called', () => {
  it('calls query exactly once for a single-turn run', async () => {
    const { fn, calls } = fakeQuery([[{ text: 'ok' }]]);
    const engine = engineFor(fn);
    await engine.run({ ...REQUEST, env: { PATH: '/usr/bin' } });
    expect(calls).toHaveLength(1);
  });
});

describe('the ceiling, driven by real usage events', () => {
  it('two 40000-then-25000 usage messages do not hand off under a 60000 ceiling, because each message already carries its whole context and summing them double-counts the shared prefix', async () => {
    const { fn } = fakeQuery([
      [
        { text: 'working', usage: { input: 40_000, cacheRead: 0, cacheCreation: 0, output: 10 } },
        { text: 'still working', usage: { input: 25_000, cacheRead: 0, cacheCreation: 0, output: 10 } },
      ],
      [{ text: 'done', usage: { input: 100, cacheRead: 0, cacheCreation: 0, output: 10 },
        toolUse: { name: 'mcp__forge__forge_done', input: { evidence: 'shipped' } } }],
    ]);
    const engine = engineFor(fn);
    const worker = new Worker({
      run: 'ceiling-run', brief: '# Goal\n\nDo the thing.\n', briefPath: join(home, 'brief.md'),
      cwd: home, journalPath, engine: engine as never, maxContext: 60_000,
    });
    const result = await worker.run();

    expect(result.handoffs).toBe(0);
    const state = replay(journalPath);
    expect(state.events.filter((e) => e.event === 'run.handoff')).toHaveLength(0);
  });

  it('one message of 61000 alone does hand off under a 60000 ceiling', async () => {
    const { fn } = fakeQuery([
      [{ text: 'working', usage: { input: 61_000, cacheRead: 0, cacheCreation: 0, output: 10 } }],
      [{ text: 'handoff packet', usage: { input: 100, cacheRead: 0, cacheCreation: 0, output: 10 } }],
      [{ text: 'done', usage: { input: 100, cacheRead: 0, cacheCreation: 0, output: 10 },
        toolUse: { name: 'mcp__forge__forge_done', input: { evidence: 'shipped' } } }],
    ]);
    const engine = engineFor(fn);
    const worker = new Worker({
      run: 'ceiling-run-2', brief: '# Goal\n\nDo the thing.\n', briefPath: join(home, 'brief.md'),
      cwd: home, journalPath, engine: engine as never, maxContext: 60_000,
    });
    const result = await worker.run();

    expect(result.handoffs).toBe(1);
    const state = replay(journalPath);
    expect(state.events.filter((e) => e.event === 'run.handoff')).toHaveLength(1);
  });

  it('carries the forge_handoff tool call\'s packet into the successor\'s prompt', async () => {
    const { fn } = fakeQuery([
      [{ text: 'working', usage: { input: 65_000, cacheRead: 0, cacheCreation: 0, output: 10 } }],
      [{
        text: '', usage: { input: 100, cacheRead: 0, cacheCreation: 0, output: 10 },
        toolUse: { name: 'mcp__forge__forge_handoff', input: { packet: 'left off at src/x.ts:42' } },
      }],
      [{ text: 'done', usage: { input: 100, cacheRead: 0, cacheCreation: 0, output: 10 },
        toolUse: { name: 'mcp__forge__forge_done', input: { evidence: 'shipped' } } }],
    ]);
    const engine = engineFor(fn);
    const worker = new Worker({
      run: 'handoff-run', brief: '# Goal\n\nDo the thing.\n', briefPath: join(home, 'brief.md'),
      cwd: home, journalPath, engine: engine as never, maxContext: 60_000,
    });
    await worker.run();

    expect(engine.started[1]?.prompt).toContain('left off at src/x.ts:42');
  });
});

describe('forge_done is only honoured on a clean result', () => {
  it('an errored forge_done tool result yields run.finished with verdict stopped, not done', async () => {
    const { fn } = fakeQuery([
      [{ text: 'trying', usage: { input: 100, cacheRead: 0, cacheCreation: 0, output: 10 },
        toolUse: { name: 'mcp__forge__forge_done', input: { evidence: 'shipped' }, isError: true } }],
    ]);
    const engine = engineFor(fn);
    const worker = new Worker({
      run: 'errored-done-run', brief: '# Goal\n\nDo the thing.\n', briefPath: join(home, 'brief.md'),
      cwd: home, journalPath, engine: engine as never, maxContext: 60_000,
    });
    const result = await worker.run();

    expect(result.verdict).not.toBe('done');
    const state = replay(journalPath);
    const finished = state.events.find((e) => e.event === 'run.finished' && e.run === 'errored-done-run');
    expect(finished?.['verdict']).toBe('stopped');
  });
});

describe('the journal handle across a chain', () => {
  it('reuses one handle across every session in a chain and closes cleanly', async () => {
    const { fn } = fakeQuery([
      [{ text: 'working', usage: { input: 65_000, cacheRead: 0, cacheCreation: 0, output: 10 } }],
      [{ text: 'done', usage: { input: 100, cacheRead: 0, cacheCreation: 0, output: 10 },
        toolUse: { name: 'mcp__forge__forge_done', input: { evidence: 'shipped' } } }],
    ]);
    const engine = engineFor(fn);
    const worker = new Worker({
      run: 'chain-run', brief: '# Goal\n\nDo the thing.\n', briefPath: join(home, 'brief.md'),
      cwd: home, journalPath, engine: engine as never, maxContext: 60_000,
    });
    await worker.run();
    expect(() => engine.close()).not.toThrow();

    const state = replay(journalPath);
    expect(state.torn).toBe(0);
    expect(state.events.some((e) => e.run === 'chain-run')).toBe(true);
    expect(state.events.some((e) => e.run === 'chain-run-2')).toBe(true);
  });
});

describe('the PreToolUse inbox hook, wired into a real run', () => {
  it('delivers a queued message verbatim on the first tool call and marks it read', async () => {
    // The fake `query` never calls a hook — only the real CLI subprocess does that. So
    // this drives the hook the same way buildOptions wires it for a real session: built
    // from an SdkEngine run's own config, then invoked directly with a Bash hook input.
    new RunInbox(REQUEST.run).send('rebase before you push', 'console');
    const { fn } = fakeQuery([[{ text: 'ok' }]]);
    const engine = engineFor(fn, { deliverVia: 'hook' });
    await engine.run({ ...REQUEST, env: { PATH: '/usr/bin' } });

    const { buildOptions } = await import('../../src/adapter/engine.js');
    const { buildInboxHook } = await import('../../src/forge/sdkengine.js');
    const { Journal } = await import('../../src/forge/journal.js');
    const journal = new Journal(journalPath);
    const options = buildOptions({
      cwd: home, canUseTool: (async () => ({ behavior: 'deny', message: 'x' })) as never,
      onToolCall: buildInboxHook({ run: REQUEST.run, journal }),
    });
    const hook = options.hooks!['PreToolUse']![0]!.hooks[0]!;

    const first = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } } as never,
      'tu-1', {} as never,
    );
    const firstOut = (first as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput;
    expect(firstOut?.additionalContext).toContain('rebase before you push');
    expect(new RunInbox(REQUEST.run).unread()).toHaveLength(0);

    const second = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } } as never,
      'tu-2', {} as never,
    );
    const secondOut = (second as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput;
    expect(secondOut?.additionalContext).toBeUndefined();

    journal.close();
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'inbox.delivered' && e.via === 'hook')).toBe(true);
  });
});

describe('the stream fallback delivery', () => {
  it('pushes the queued message through the streaming input as a user message', async () => {
    new RunInbox('stream-run').send('the PR conflicts with main', 'console');
    let seenPrompt = '';
    const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
      const promptIter = params.prompt as AsyncIterable<{ message: { content: string } }>;
      async function* generate() {
        yield {
          type: 'system', subtype: 'init', session_id: 's', model: '', cwd: '', tools: [],
          slash_commands: [],
        };
        for await (const pushed of promptIter) {
          seenPrompt = pushed.message.content;
          yield {
            type: 'assistant', session_id: 's',
            message: { model: '', content: [{ type: 'text', text: 'ack' }],
              usage: { input_tokens: 1, output_tokens: 1 } },
          };
          yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1 };
          return;
        }
      }
      return generate() as unknown as Query;
    }) as unknown as QueryFn;

    const engine = engineFor(fn, { deliverVia: 'stream' });
    await engine.run({ ...REQUEST, run: 'stream-run', prompt: 'do the goal', env: { PATH: '/usr/bin' } });

    expect(seenPrompt).toContain('the PR conflicts with main');
    expect(seenPrompt).toContain('do the goal');
    expect(new RunInbox('stream-run').unread()).toHaveLength(0);
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'inbox.delivered' && e.via === 'stream')).toBe(true);
  });

  it('leaves the message unread when the push itself throws', () => {
    new RunInbox('stream-reject-run').send('rebase before you push', 'console');
    const journal = new Journal(journalPath);
    const throwingEngine = { send: () => { throw new Error('stream is gone'); } };

    expect(() => deliverViaStream(throwingEngine, 'stream-reject-run', 'do the goal', journal))
      .toThrow('stream is gone');

    journal.close();
    expect(new RunInbox('stream-reject-run').unread()).toHaveLength(1);
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'inbox.delivered')).toBe(false);
  });
});

describe('canUseTool, invoked directly', () => {
  it('denies an arbitrary tool and journals permission.denied', async () => {
    const inbox = new Inbox(join(home, 'inbox2'));
    const journal = new (await import('../../src/forge/journal.js')).Journal(journalPath);
    const canUseTool = buildCanUseTool({ run: 'r2', inbox, journal });

    const verdict = await canUseTool('Bash', { command: 'rm -rf /' });
    expect(verdict.behavior).toBe('deny');
    journal.close();

    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'permission.denied' && e['tool'] === 'Bash')).toBe(true);
  });

  it('denies AskUserQuestion naming the park key, and two identical asks make one inbox entry', async () => {
    const inboxDir = join(home, 'inbox3');
    const inbox = new Inbox(inboxDir);
    const journal = new (await import('../../src/forge/journal.js')).Journal(journalPath);
    const canUseTool = buildCanUseTool({ run: 'r3', inbox, journal });

    const askInput = {
      questions: [{ question: 'dev or prod?', header: 'env',
        options: [{ label: 'dev', description: '' }, { label: 'prod', description: '' }] }],
    };
    const first = await canUseTool('AskUserQuestion', askInput);
    const second = await canUseTool('AskUserQuestion', askInput);
    journal.close();

    expect(first.behavior).toBe('deny');
    expect((first as { message: string }).message).toMatch(/parking on [0-9a-f]+/);
    expect(inbox.all()).toHaveLength(1);
    expect(inbox.all()[0]?.asked).toBe(2);
    void second;
  });
});

describe('journaling a tool call as it happens', () => {
  it('writes tool.start and tool.end so a run\'s currentTool can be read back from the journal', async () => {
    const { fn } = fakeQuery([
      [
        { text: 'checking', toolUse: { name: 'Bash', input: { command: 'npm test' }, noResult: true },
          usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1 } },
      ],
    ]);
    const engine = engineFor(fn);
    await engine.run({ ...REQUEST, run: 'tool-run', env: { PATH: '/usr/bin' } });

    const state = replay(journalPath);
    const started = state.events.find((e) => e.event === 'tool.start' && e.run === 'tool-run');
    expect(started?.['tool']).toBe('Bash');
    // No matching tool-result was emitted, so the run's currentTool stays open --
    // which is exactly the case liveness's tool-budget signal exists to catch.
    expect(state.runs['tool-run']?.currentTool?.name).toBe('Bash');
  });
});

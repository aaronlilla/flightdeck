/**
 * The production `EngineLike`, driven end to end against a fake `query`.
 *
 * No model is called anywhere in this file (or anywhere in the suite: `tests/setup.ts`
 * makes the SDK's real `query` throw). The fake below stands in for a live session: it
 * captures every call `SdkEngine` makes into it, and answers each pushed prompt with a
 * scripted sequence of assistant messages followed by a `result`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';

import type { QueryFn } from '../../src/adapter/engine.js';
import { INHERITED, Worker } from '../../src/forge/worker.js';
import { replay } from '../../src/forge/journal.js';
import { RunInbox } from '../../src/forge/runinbox.js';
import { Inbox } from '../../src/forge/inbox.js';
import {
  buildCanUseTool, buildForgeToolHandlers, buildPreToolUseHook, deliverViaStream, SdkEngine,
} from '../../src/forge/sdkengine.js';
import { Journal } from '../../src/forge/journal.js';
import { Gotchas } from '../../src/forge/gotcha.js';
import { BlockerBoard } from '../../src/forge/blockers.js';
import { CredentialHorizon } from '../../src/forge/credential-horizon.js';
import { readMergeableDetailed } from '../../src/forge/drift.js';

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

describe('I12: the session id is captured on the SDK init message', () => {
  it('calls onSessionStarted with the run, session id and model, not only after the segment resolves', async () => {
    const { fn } = fakeQuery([[{ text: 'ok', usage: { input: 1, cacheRead: 0, cacheCreation: 0, output: 1 } }]]);
    const started: Array<{ run: string; sessionId: string; model: string }> = [];
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-session'), gotchasDir: join(home, 'gotchas-session'),
      queryFn: fn,
      onSessionStarted: (run, sessionId, model) => { started.push({ run, sessionId, model }); },
    });

    await engine.run({ ...REQUEST, env: { PATH: '/usr/bin' } });

    // `fakeQuery`'s generator yields the `system`/`init` message before it ever reads a
    // pushed prompt (see the fixture above), the same order the real SDK opens a
    // session in -- so this call has already happened by the time any tool call or the
    // segment's own result could arrive.
    expect(started).toEqual([{ run: 'r1', sessionId: 'sdk-fake-session', model: 'claude-sonnet-5' }]);
  });

  it('fires once per session, not again on a chain\'s later segment', async () => {
    const { fn } = fakeQuery([[{ text: 'first' }], [{ text: 'second' }]]);
    const started: string[] = [];
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-session2'), gotchasDir: join(home, 'gotchas-session2'),
      queryFn: fn,
      onSessionStarted: (_run, sessionId) => { started.push(sessionId); },
    });

    const session = await engine.run({ ...REQUEST, env: { PATH: '/usr/bin' } });
    await session.send?.('go on');

    expect(started).toEqual(['sdk-fake-session']);
  });
});

describe('B.3.9: the class effort reaches the engine options', () => {
  it('carries the effort from the session request through to the SDK options', async () => {
    const { fn, calls } = fakeQuery([[{ text: 'ok' }]]);
    const engine = engineFor(fn);
    await engine.run({ ...REQUEST, env: { PATH: '/usr/bin' }, effort: 'high' } as never);
    expect((calls[0]!.options as unknown as { effort?: string }).effort).toBe('high');
  });

  it('the falsifier: no effort on the request means none reaches the options', async () => {
    const { fn, calls } = fakeQuery([[{ text: 'ok' }]]);
    const engine = engineFor(fn);
    await engine.run({ ...REQUEST, env: { PATH: '/usr/bin' } });
    expect((calls[0]!.options as unknown as { effort?: string }).effort).toBeUndefined();
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
      // I14: the segment still has neither `done` nor a ceiling hit after the errored
      // call, so the worker nudges (twice, its own cap) before it gives up -- one more
      // plain reply per nudge, so the fake stream has something to answer with.
      [{ text: 'still stuck' }],
      [{ text: 'still stuck' }],
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
      // Consumed by `requestHandoff`'s own `send()` for the packet, not by the
      // successor's first turn.
      [{ text: 'packet' }],
      // The successor's actual first turn: a clean finish, so it never needs I14's nudge.
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
      onToolCall: buildInboxHook({ run: REQUEST.run, goal: REQUEST.run, journal }),
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

describe('B.3.7: the inbox survives a handoff', () => {
  it('a message sent to the goal id reaches the successor, which runs under goal-2', async () => {
    const sent = new RunInbox('goal-run').send('the PR conflicts with main', 'console');
    const { fn } = fakeQuery([
      [{ text: 'working', usage: { input: 65_000, cacheRead: 0, cacheCreation: 0, output: 10 } }],
      [{ text: 'packet', usage: { input: 100, cacheRead: 0, cacheCreation: 0, output: 10 } }],
      [{ text: 'ok', usage: { input: 100, cacheRead: 0, cacheCreation: 0, output: 10 } }],
      // I14: the successor's first turn above ends with neither `done` nor a ceiling
      // hit, so the worker sends a nudge on the same session; this answers it cleanly.
      [{ text: 'done', usage: { input: 100, cacheRead: 0, cacheCreation: 0, output: 10 },
        toolUse: { name: 'mcp__forge__forge_done', input: { evidence: 'shipped' } } }],
    ]);
    const engine = engineFor(fn);
    const worker = new Worker({
      run: 'goal-run', brief: '# Goal\n\nDo the thing.\n', briefPath: join(home, 'brief.md'),
      cwd: home, journalPath, engine: engine as never, maxContext: 60_000,
    });
    await worker.run();

    // The falsifier this closes: if the successor were given the original run name
    // ("goal-run") rather than actually running under "goal-run-2" scoped by a separate
    // stable goal id, this would pass for the wrong reason -- so this pins both: the
    // successor's own segment name, and the goal id that still names the pre-handoff run.
    expect(engine.started[1]?.run).toBe('goal-run-2');
    expect(engine.started[1]?.goal).toBe('goal-run');
    // The message was never marked read: nothing in this run consumed it under
    // "goal-run-2" (fakeQuery never drives a real PreToolUse hook), which is exactly why
    // it is still sitting there, addressable only by the goal id it was sent to.
    expect(new RunInbox('goal-run').unread().map((message) => message.id)).toContain(sent.id);
  });

  it('inbox.acknowledged names the message id once the delivered text appears in the next assistant message', async () => {
    const sent = new RunInbox('ack-run').send('the PR conflicts with main', 'console');
    const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
      const hookEntry = (params.options as unknown as {
        hooks?: { PreToolUse?: Array<{ hooks: Array<(input: unknown, id: string, ctx: unknown) =>
          Promise<{ hookSpecificOutput?: { additionalContext?: string } }>> }> };
      }).hooks?.['PreToolUse']?.[0]?.hooks[0];
      const promptIter = params.prompt as AsyncIterable<unknown>;
      async function* generate() {
        yield {
          type: 'system', subtype: 'init', session_id: 's', model: '', cwd: '', tools: [],
          slash_commands: [],
        };
        for await (const _pushed of promptIter) {
          // The tool call the hook rides on -- ordinary Bash, denied by canUseTool but
          // that is irrelevant here: onToolCall (not canUseTool) is what delivers.
          await hookEntry?.(
            { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }, 'tu-1', {},
          );
          yield {
            type: 'assistant', session_id: 's',
            message: {
              model: '', content: [{ type: 'text', text: 'Read it: the PR conflicts with main. Rebasing now.' }],
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          };
          yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1 };
          return;
        }
      }
      return generate() as unknown as Query;
    }) as unknown as QueryFn;

    const engine = engineFor(fn);
    await engine.run({ ...REQUEST, run: 'ack-run', env: { PATH: '/usr/bin' } });

    const state = replay(journalPath);
    const acknowledged = state.events.find((e) => e.event === 'inbox.acknowledged' && e.run === 'ack-run');
    expect(acknowledged?.['messageId']).toBe(sent.id);
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
    const canUseTool = buildCanUseTool({ run: 'r2', goal: 'r2', inbox, journal, parked: new Map() });

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
    const canUseTool = buildCanUseTool({ run: 'r3', goal: 'r3', inbox, journal, parked: new Map() });

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

  it('B.3.9: a two-question AskUserQuestion parks both, naming the count in the reason', async () => {
    const inbox = new Inbox(join(home, 'inbox-multi'));
    const journal = new (await import('../../src/forge/journal.js')).Journal(journalPath);
    const canUseTool = buildCanUseTool({ run: 'r4', goal: 'r4', inbox, journal, parked: new Map() });

    const askInput = {
      questions: [
        { question: 'dev or prod?', options: [{ label: 'dev' }, { label: 'prod' }] },
        { question: 'now or later?', options: [{ label: 'now' }, { label: 'later' }] },
      ],
    };
    const verdict = await canUseTool('AskUserQuestion', askInput);
    journal.close();

    const entry = inbox.all()[0];
    expect(entry?.question).toMatch(/2 questions/);
    expect(entry?.question).toContain('dev or prod?');
    expect(entry?.question).toContain('now or later?');
    expect(entry?.options.sort()).toEqual(['dev', 'later', 'now', 'prod'].sort());
    expect((verdict as { message: string }).message).toMatch(/2 questions/);
  });
});

describe('B.3.6: honest recording', () => {
  it('sentence 3, already on main at a4c9c40: a non-fatal engine error is journaled, not dropped', async () => {
    const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
      const promptIter = params.prompt as AsyncIterable<unknown>;
      async function* generate() {
        yield {
          type: 'system', subtype: 'init', session_id: 's', model: '', cwd: '', tools: [],
          slash_commands: [],
        };
        for await (const _pushed of promptIter) {
          yield {
            type: 'assistant', session_id: 's',
            message: { model: '', content: [{ type: 'text', text: 'retrying' }] },
            error: 'rate_limited',
          };
          yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1 };
          return;
        }
      }
      return generate() as unknown as Query;
    }) as unknown as QueryFn;

    const engine = engineFor(fn);
    await engine.run({ ...REQUEST, run: 'error-run', env: { PATH: '/usr/bin' } });

    const state = replay(journalPath);
    const errorRow = state.events.find((e) => e.event === 'engine.error' && e.run === 'error-run');
    expect(errorRow?.['message']).toContain('rate_limited');
    expect(errorRow?.['fatal']).toBe(false);
  });

  // Sentence 5 ("one Journal per engine, closed with it") is also already on main at
  // a4c9c40: SdkEngine's constructor opens exactly one Journal, reused by every session
  // run() starts and closed once by close(). No new specimen needed -- "the journal
  // handle across a chain" describe block above already proves state.torn stays 0 across
  // a two-session chain, which a leaked-and-reopened handle on Windows would not survive.

  it('sentence 2: journals the message\'s own serving model on turn.end, not just the class-selected one', async () => {
    const { fn } = fakeQuery([[{
      text: 'shipped', usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1 },
      toolUse: { name: 'mcp__forge__forge_done', input: { evidence: 'shipped' } },
    }]]);
    // The fake reports whatever model the SDK options carried; a real fallback reroute
    // would report something different from what was asked for, which is the whole point.
    // turn.end is journaled by Worker, which is what this drives through rather than
    // SdkEngine.run() directly.
    const engine = engineFor(fn);
    const worker = new Worker({
      run: 'model-run', brief: '# Goal\n\nDo the thing.\n', briefPath: join(home, 'brief.md'),
      cwd: home, journalPath, engine: engine as never, maxContext: 60_000,
    });
    await worker.run();

    const state = replay(journalPath);
    const turnEnd = state.events.find((e) => e.event === 'turn.end' && e.run === 'model-run');
    expect(turnEnd?.['messageModel']).toBe('claude-sonnet-5');
  });

  it('sentence 4: a subagent message (parent_tool_use_id set) is skipped for context and counted for cost', async () => {
    const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
      const promptIter = params.prompt as AsyncIterable<unknown>;
      async function* generate() {
        yield {
          type: 'system', subtype: 'init', session_id: 's', model: '', cwd: '', tools: [],
          slash_commands: [],
        };
        for await (const _pushed of promptIter) {
          yield {
            type: 'assistant', session_id: 's', parent_tool_use_id: 'tu-agent',
            message: {
              model: 'claude-sonnet-5', content: [{ type: 'text', text: 'subagent working' }],
              usage: {
                input_tokens: 200_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
                output_tokens: 10,
              },
            },
          };
          yield {
            type: 'assistant', session_id: 's',
            message: {
              model: 'claude-sonnet-5', content: [{ type: 'text', text: 'main loop' }],
              usage: {
                input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
                output_tokens: 1,
              },
            },
          };
          yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1 };
          return;
        }
      }
      return generate() as unknown as Query;
    }) as unknown as QueryFn;

    const engine = engineFor(fn);
    // request.ceiling is set below the subagent's 200,000 tokens but above the main
    // loop's 100: if the subagent's usage were not skipped, the single turn SdkEngine
    // hands back would carry a context at or past the ceiling. It must not, because none
    // of that 200,000 belongs to the main loop this ceiling governs.
    const { turns } = await engine.run({
      ...REQUEST, run: 'subagent-run', env: { PATH: '/usr/bin' }, ceiling: 60_000,
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]?.context).toBe(100);
    // Isolated from the main loop's own 100-token turn: this asserts the subagent's own
    // 200,000 tokens were journaled for cost under their own row, not merely that some
    // burn exists (which the main loop's turn.end would produce on its own either way).
    const state = replay(journalPath);
    const subagentRow = state.events.find((e) => e.event === 'subagent.usage' && e.run === 'subagent-run');
    expect((subagentRow?.['usage'] as { input: number } | undefined)?.input).toBe(200_000);
    expect(state.burn['sonnet']).toBeGreaterThan(0.5);
  });
});

describe('B.3.1: park is a state', () => {
  it('canUseTool parks the run and the pretool hook denies every tool call until answered', async () => {
    const parked = new Map<string, string>();
    const inbox = new Inbox(join(home, 'inbox-park'));
    const journal = new Journal(journalPath);
    const canUseTool = buildCanUseTool({ run: 'park-run', goal: 'park-run', inbox, journal, parked });

    const askInput = {
      questions: [{ question: 'dev or prod?', header: 'env',
        options: [{ label: 'dev', description: '' }, { label: 'prod', description: '' }] }],
    };
    await canUseTool('AskUserQuestion', askInput);
    const key = parked.get('park-run');
    expect(key).toBeTruthy();

    const hook = buildPreToolUseHook({ run: 'park-run', goal: 'park-run', parked, journal, inbox, deliverVia: 'hook' });
    const denied = await hook({ toolName: 'Bash', input: { command: 'npm test' }, toolUseId: 'tu-1' });
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toContain(key);

    journal.close();
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'permission.denied' && e.run === 'park-run'
      && String(e['reason'] ?? '').includes(key!))).toBe(true);
  });

  it('the falsifier: a tool call after the ask still executes if the guard is skipped', async () => {
    // Same setup as above, but with an empty `parked` map, to prove the hook only denies
    // because the map says the run is parked, never unconditionally.
    const parked = new Map<string, string>();
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-unparked'));
    const hook = buildPreToolUseHook({
      run: 'unparked-run', goal: 'unparked-run', parked, journal, inbox, deliverVia: 'hook',
    });
    const verdict = await hook({ toolName: 'Bash', input: {}, toolUseId: 'tu-1' });
    expect(verdict.decision).toBeUndefined();
  });

  it('forge answer clears the park and delivers the answer verbatim as the next user message', async () => {
    let seenPrompts: string[] = [];
    const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
      const promptIter = params.prompt as AsyncIterable<{ message: { content: string } }>;
      async function* generate() {
        yield {
          type: 'system', subtype: 'init', session_id: 's', model: '', cwd: '', tools: [],
          slash_commands: [],
        };
        for await (const pushed of promptIter) {
          seenPrompts.push(pushed.message.content);
          yield {
            type: 'assistant', session_id: 's',
            message: { model: '', content: [{ type: 'text', text: 'ack' }],
              usage: { input_tokens: 1, output_tokens: 1 } },
          };
          yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1 };
        }
      }
      return generate() as unknown as Query;
    }) as unknown as QueryFn;

    const parked = new Map<string, string>([['answer-run', 'abc123']]);
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-park2'), gotchasDir: join(home, 'gotchas-park'),
      queryFn: fn, parked,
    });
    await engine.run({ ...REQUEST, run: 'answer-run', env: { PATH: '/usr/bin' } });

    const result = await engine.answer('answer-run', 'abc123', 'go with dev');
    expect(result.delivered).toBe(true);
    expect(seenPrompts).toContain('go with dev');
    expect(parked.has('answer-run')).toBe(false);

    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'run.resumed' && e.run === 'answer-run')).toBe(true);
  });

  it('the falsifier: answering the wrong key delivers nothing', async () => {
    const { fn } = fakeQuery([[{ text: 'ok' }]]);
    const parked = new Map<string, string>([['wrong-key-run', 'real-key']]);
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-park3'), gotchasDir: join(home, 'gotchas-park3'),
      queryFn: fn, parked,
    });
    await engine.run({ ...REQUEST, run: 'wrong-key-run', env: { PATH: '/usr/bin' } });

    const result = await engine.answer('wrong-key-run', 'nope', 'go with dev');
    expect(result.delivered).toBe(false);
    expect(parked.get('wrong-key-run')).toBe('real-key');
  });
});

describe('F2: the hook consults the shared answer while parked', () => {
  it('allows the call and resumes once a separate Inbox instance writes the answer', async () => {
    const parked = new Map<string, string>();
    const inbox = new Inbox(join(home, 'inbox-f2'));
    const journal = new Journal(journalPath);
    const canUseTool = buildCanUseTool({ run: 'f2-run', goal: 'f2-run', inbox, journal, parked });
    await canUseTool('AskUserQuestion', {
      questions: [{ question: 'dev or prod?', options: [{ label: 'dev' }, { label: 'prod' }] }],
    });
    const key = parked.get('f2-run');
    expect(key).toBeTruthy();

    // A second `Inbox` instance on the same directory, standing in for a separate `forge
    // answer` process. This never touches `SdkEngine.answer()`, which only ever reaches a
    // session the process holding it still has open.
    new Inbox(join(home, 'inbox-f2')).answer(key!, 'go with dev');

    const hook = buildPreToolUseHook({
      run: 'f2-run', goal: 'f2-run', parked, journal, inbox, deliverVia: 'hook',
    });
    const verdict = await hook({ toolName: 'Bash', input: { command: 'npm test' }, toolUseId: 'tu-1' });

    expect(verdict.decision).toBeUndefined();
    expect(verdict.additionalContext).toContain('go with dev');
    expect(parked.has('f2-run')).toBe(false);

    journal.close();
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'run.resumed' && e.run === 'f2-run')).toBe(true);
  });

  it('the falsifier: still denies while parked with no answer written', async () => {
    const parked = new Map<string, string>([['f2-deny-run', 'some-key']]);
    const inbox = new Inbox(join(home, 'inbox-f2-deny'));
    const journal = new Journal(journalPath);
    const hook = buildPreToolUseHook({
      run: 'f2-deny-run', goal: 'f2-deny-run', parked, journal, inbox, deliverVia: 'hook',
    });
    const verdict = await hook({ toolName: 'Bash', input: {}, toolUseId: 'tu-1' });
    expect(verdict.decision).toBe('deny');
    expect(parked.has('f2-deny-run')).toBe(true);
  });
});

describe('B.3.3: the ceiling fires inside the turn', () => {
  it('denies a tool call inside the same turn once usage crosses the ceiling, before the segment resolves', async () => {
    const executed: string[] = [];
    const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
      const hookEntry = (params.options as unknown as {
        hooks?: { PreToolUse?: Array<{ hooks: Array<(input: unknown, id: string, ctx: unknown) =>
          Promise<{ continue: boolean }>> }> };
      }).hooks?.['PreToolUse']?.[0]?.hooks[0];
      const promptIter = params.prompt as AsyncIterable<unknown>;
      const steps = [
        { usage: { input: 1_000, cacheRead: 0, cacheCreation: 0, output: 1 }, toolName: 'Bash' },
        { usage: { input: 65_000, cacheRead: 0, cacheCreation: 0, output: 1 }, toolName: 'Bash' },
        { toolName: 'Bash' },
      ];
      async function* generate() {
        yield {
          type: 'system', subtype: 'init', session_id: 'gated', model: '', cwd: '', tools: [],
          slash_commands: [],
        };
        for await (const _pushed of promptIter) {
          for (const step of steps) {
            if (step.usage) {
              yield {
                type: 'assistant', session_id: 'gated',
                message: {
                  model: '', content: [],
                  usage: {
                    input_tokens: step.usage.input, cache_read_input_tokens: step.usage.cacheRead,
                    cache_creation_input_tokens: step.usage.cacheCreation,
                    output_tokens: step.usage.output,
                  },
                },
              };
            }
            const toolUseId = `tu-${executed.length}`;
            const verdict = hookEntry
              ? await hookEntry(
                { hook_event_name: 'PreToolUse', tool_name: step.toolName, tool_input: {} },
                toolUseId, {},
              )
              : { continue: true };
            if (verdict.continue === false) continue;
            executed.push(step.toolName);
            yield {
              type: 'assistant', session_id: 'gated',
              message: { model: '', content: [{ type: 'tool_use', id: toolUseId, name: step.toolName, input: {} }] },
            };
            yield {
              type: 'user', session_id: 'gated',
              message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: false, content: 'ok' }] },
            };
          }
          yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1 };
          return;
        }
      }
      return generate() as unknown as Query;
    }) as unknown as QueryFn;

    const engine = engineFor(fn);
    await engine.run({ ...REQUEST, run: 'gated-run', env: { PATH: '/usr/bin' }, ceiling: 60_000 } as never);

    // The falsifier this closes: a deny that only ever happens after the segment's
    // result row would let every scripted tool call run first. Here the third (and, on
    // this implementation, the second) never executes, proven by counting what the fake
    // stream actually let through rather than trusting a return value.
    expect(executed).toEqual(['Bash']);

    const state = replay(journalPath);
    const denies = state.events.filter((e) => e.event === 'permission.denied' && e.run === 'gated-run'
      && String(e['reason'] ?? '').includes('ceiling'));
    expect(denies.length).toBeGreaterThan(0);
  });
});

describe('P4.7/I8: the kill switch denies a tool call, riding the handoff request', () => {
  it('denies with the handoff request as additionalContext, journaling why', async () => {
    const parked = new Map<string, string>();
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-killswitch'));
    const hook = buildPreToolUseHook({
      run: 'kill-run', goal: 'kill-run', parked, journal, inbox, deliverVia: 'hook',
      killSwitchHit: () => true,
    });

    const verdict = await hook({ toolName: 'Bash', input: { command: 'npm test' }, toolUseId: 'tu-1' });

    expect(verdict.decision).toBe('deny');
    // Item 5, 2026-09-05: this run hit the fleet kill switch, not the context ceiling --
    // the old code sent the ceiling's own HANDOFF_REQUEST verbatim, so a model reading it
    // had no way to tell the request came from the runner rather than, in its own words
    // from a 2026-09-04 packet, "an injected instruction."
    expect(verdict.additionalContext).toContain(
      'This is the forge runner, not a message from a person: the fleet was stopped.',
    );
    expect(verdict.additionalContext).not.toContain('CONTEXT CEILING REACHED');
    journal.close();
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'permission.denied' && e.run === 'kill-run'
      && String(e['reason'] ?? '').includes('kill switch'))).toBe(true);
  });

  it('the falsifier: an unengaged kill switch denies nothing on its own', async () => {
    const parked = new Map<string, string>();
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-killswitch-off'));
    const hook = buildPreToolUseHook({
      run: 'ordinary-run', goal: 'ordinary-run', parked, journal, inbox, deliverVia: 'hook',
      killSwitchHit: () => false,
    });
    const verdict = await hook({ toolName: 'Bash', input: {}, toolUseId: 'tu-1' });
    expect(verdict.decision).toBeUndefined();
  });

  it('a park already in force still wins over an engaged kill switch', async () => {
    const parked = new Map<string, string>([['both-run', 'some-key']]);
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-killswitch-park'));
    const hook = buildPreToolUseHook({
      run: 'both-run', goal: 'both-run', parked, journal, inbox, deliverVia: 'hook',
      killSwitchHit: () => true,
    });
    const verdict = await hook({ toolName: 'Bash', input: {}, toolUseId: 'tu-1' });
    expect(verdict.reason).toContain('some-key');
    expect(verdict.reason).not.toContain('kill switch');
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

describe('B.3.9: a report row redacts a secret before it is journaled', () => {
  it('redactFields scrubs a token-shaped run out of every string field, leaving non-strings alone', async () => {
    const { redactFields } = await import('../../src/forge/redact.js');
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const cleaned = redactFields({
      outcome: 'done', done: `pushed with token ${secret}`, cost: 3.5,
    });
    expect(cleaned['done']).not.toContain(secret);
    expect(cleaned['done']).toContain('[REDACTED]');
    expect(cleaned['cost']).toBe(3.5);
  });

});

describe('B.3.9: drift raised after a push', () => {
  it('a conflicting mergeable state after git push raises a blocker', async () => {
    const { fn } = fakeQuery([[{
      text: 'pushed', usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1 },
      toolUse: { name: 'Bash', input: { command: 'git push' } },
    }]]);
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-drift'), gotchasDir: join(home, 'gotchas-drift'),
      queryFn: fn, checkDrift: async () => 'CONFLICTING',
    });
    await engine.run({ ...REQUEST, run: 'drift-run', env: { PATH: '/usr/bin' } });
    // The check is fire-and-forget from the tool-result handler; give its microtask a
    // turn to settle before reading what it did.
    await new Promise((resolve) => setImmediate(resolve));

    const inbox = new Inbox(join(home, 'inbox-drift'));
    expect(inbox.open()).toHaveLength(1);
    expect(inbox.open()[0]?.question).toMatch(/conflicts/);
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'run.blocked' && e.run === 'drift-run')).toBe(true);
  });

  it('the falsifier: the check is called but a MERGEABLE result raises nothing', async () => {
    const { fn } = fakeQuery([[{
      text: 'pushed', usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1 },
      toolUse: { name: 'Bash', input: { command: 'git push origin feature/x' } },
    }]]);
    let called = false;
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-drift2'), gotchasDir: join(home, 'gotchas-drift2'),
      queryFn: fn, checkDrift: async () => { called = true; return 'MERGEABLE'; },
    });
    await engine.run({ ...REQUEST, run: 'drift-run-2', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(called).toBe(true);
    const inbox = new Inbox(join(home, 'inbox-drift2'));
    expect(inbox.open()).toHaveLength(0);
  });

  it('a command that only mentions "git push" in an argument does not fire the drift check', async () => {
    const { fn } = fakeQuery([[{
      text: 'searched', usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1 },
      toolUse: { name: 'Bash', input: { command: 'git log --grep "git push"' } },
    }]]);
    let called = false;
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-drift3'), gotchasDir: join(home, 'gotchas-drift3'),
      queryFn: fn, checkDrift: async () => { called = true; return 'MERGEABLE'; },
    });
    await engine.run({ ...REQUEST, run: 'drift-run-3', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(called).toBe(false);
  });
});

describe('I16: the post-push drift check retries an UNKNOWN read before raising', () => {
  /** Advances its own virtual clock on `sleep` instead of waiting for real -- the
   *  item's own falsifier is a specimen that sleeps for real. */
  function fakeDriftClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let now = 0;
    return { now: () => now, sleep: async (ms) => { now += ms; } };
  }

  it('unknown twice then mergeable raises nothing, after retrying through the injected clock', async () => {
    const { fn } = fakeQuery([[{
      text: 'pushed', usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1 },
      toolUse: { name: 'Bash', input: { command: 'git push' } },
    }]]);
    const reads = ['UNKNOWN', 'UNKNOWN', 'MERGEABLE'] as const;
    let calls = 0;
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-drift-i16-1'), gotchasDir: join(home, 'gotchas-drift-i16-1'),
      queryFn: fn, checkDrift: async () => reads[calls++]!, driftClock: fakeDriftClock(),
    });
    await engine.run({ ...REQUEST, run: 'drift-run-i16-1', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toBe(3);
    const inbox = new Inbox(join(home, 'inbox-drift-i16-1'));
    expect(inbox.open()).toHaveLength(0);
  });

  it('unknown for the whole 90s window raises once', async () => {
    const { fn } = fakeQuery([[{
      text: 'pushed', usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1 },
      toolUse: { name: 'Bash', input: { command: 'git push' } },
    }]]);
    let calls = 0;
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-drift-i16-2'), gotchasDir: join(home, 'gotchas-drift-i16-2'),
      queryFn: fn, checkDrift: async () => { calls++; return 'UNKNOWN'; }, driftClock: fakeDriftClock(),
    });
    await engine.run({ ...REQUEST, run: 'drift-run-i16-2', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toBe(10);
    const inbox = new Inbox(join(home, 'inbox-drift-i16-2'));
    expect(inbox.open()).toHaveLength(1);
    expect(inbox.open()[0]?.question).toMatch(/could not be read, and unknown is not passing/);
  });

  it('a confirmed conflict raises at once, with no retry', async () => {
    const { fn } = fakeQuery([[{
      text: 'pushed', usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1 },
      toolUse: { name: 'Bash', input: { command: 'git push' } },
    }]]);
    let calls = 0;
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-drift-i16-3'), gotchasDir: join(home, 'gotchas-drift-i16-3'),
      queryFn: fn, checkDrift: async () => { calls++; return 'CONFLICTING'; }, driftClock: fakeDriftClock(),
    });
    await engine.run({ ...REQUEST, run: 'drift-run-i16-3', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toBe(1);
    const inbox = new Inbox(join(home, 'inbox-drift-i16-3'));
    expect(inbox.open()).toHaveLength(1);
    expect(inbox.open()[0]?.question).toMatch(/conflicts/);
  });

  it('a later push that reads mergeable clears a blocker this run raised earlier', async () => {
    const { fn } = fakeQuery([
      [{
        text: 'pushed', usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1 },
        toolUse: { name: 'Bash', input: { command: 'git push' } },
      }],
    ]);
    let reads: Array<'CONFLICTING' | 'MERGEABLE'> = ['CONFLICTING'];
    let calls = 0;
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-drift-i16-4'), gotchasDir: join(home, 'gotchas-drift-i16-4'),
      queryFn: fn, checkDrift: async () => reads[calls++]!, driftClock: fakeDriftClock(),
    });
    await engine.run({ ...REQUEST, run: 'drift-run-i16-4', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    const inbox = new Inbox(join(home, 'inbox-drift-i16-4'));
    expect(inbox.open()).toHaveLength(1);

    reads = ['MERGEABLE'];
    calls = 0;
    // Trigger the second push's drift check the same way the first one fired: a fresh
    // Bash `git push` tool-result, this time through a fresh `SdkEngine` pointed at the
    // same inbox and journal, the way a successor session after a rebase would be.
    const { fn: fn2 } = fakeQuery([[{
      text: 'pushed again', usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1 },
      toolUse: { name: 'Bash', input: { command: 'git push' } },
    }]]);
    const engine2 = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-drift-i16-4'), gotchasDir: join(home, 'gotchas-drift-i16-4'),
      queryFn: fn2, checkDrift: async () => reads[calls++]!, driftClock: fakeDriftClock(),
    });
    await engine2.run({ ...REQUEST, run: 'drift-run-i16-4', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(inbox.open()).toHaveLength(0);
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'run.unblocked' && e.run === 'drift-run-i16-4')).toBe(true);
  });
});

describe('B.3.8: `committed` reflects an actual git commit, not just the phrase appearing', () => {
  it('sets committed when the session ran git commit', async () => {
    const { fn } = fakeQuery([[{
      text: 'committed', usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1 },
      toolUse: { name: 'Bash', input: { command: 'git commit -m "fix"' } },
    }]]);
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-commit'), gotchasDir: join(home, 'gotchas-commit'),
      queryFn: fn,
    });
    const result = await engine.run({ ...REQUEST, run: 'commit-run', env: { PATH: '/usr/bin' } });
    expect(result.committed).toBe(true);
  });

  it('the falsifier: a command that only mentions "git commit" in an argument leaves committed false', async () => {
    const { fn } = fakeQuery([[{
      text: 'searched', usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1 },
      toolUse: { name: 'Bash', input: { command: 'git log --grep "git commit"' } },
    }]]);
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-commit2'), gotchasDir: join(home, 'gotchas-commit2'),
      queryFn: fn,
    });
    const result = await engine.run({ ...REQUEST, run: 'commit-run-2', env: { PATH: '/usr/bin' } });
    expect(result.committed).toBe(false);
  });
});

describe('F3: forge_ask parks', () => {
  it('parks the run and journals run.parked with the key, exactly as AskUserQuestion does', () => {
    const parked = new Map<string, string>();
    const inbox = new Inbox(join(home, 'inbox-f3'));
    const journal = new Journal(journalPath);
    const gotchas = new Gotchas(join(home, 'gotchas-f3'), journalPath);
    const handlers = buildForgeToolHandlers({
      run: 'f3-run', goal: 'f3-run', inbox, journal, parked, gotchas,
    });

    handlers.onAsk({ question: 'dev or prod?', options: ['dev', 'prod'], kind: 'question' });

    const key = parked.get('f3-run');
    expect(key).toBeTruthy();

    journal.close();
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'run.parked' && e.run === 'f3-run' && e['key'] === key))
      .toBe(true);

    // The next tool call is denied naming it, the same PreToolUse guard AskUserQuestion's
    // park relies on.
    const hookJournal = new Journal(journalPath);
    const hook = buildPreToolUseHook({
      run: 'f3-run', goal: 'f3-run', parked, journal: hookJournal, inbox, deliverVia: 'hook',
    });
    return hook({ toolName: 'Bash', input: {}, toolUseId: 'tu-1' }).then((verdict) => {
      hookJournal.close();
      expect(verdict.decision).toBe('deny');
      expect(verdict.reason).toContain(key);
    });
  });

  it('the falsifier: only asserting the AskUserQuestion path never proves forge_ask parks anything', () => {
    // Baseline forge_ask (before F3) raised the inbox entry and journaled forge.ask but
    // never touched `parked` at all: a specimen that only exercises AskUserQuestion, as the
    // B.3.1 suite above does, would stay green through that regression. This one calls
    // forge_ask's own handler directly and fails unless it parks too.
    const parked = new Map<string, string>();
    const inbox = new Inbox(join(home, 'inbox-f3-falsifier'));
    const journal = new Journal(journalPath);
    const gotchas = new Gotchas(join(home, 'gotchas-f3-falsifier'), journalPath);
    const handlers = buildForgeToolHandlers({
      run: 'f3-falsifier-run', goal: 'f3-falsifier-run', inbox, journal, parked, gotchas,
    });

    handlers.onAsk({ question: 'staging or prod?' });

    expect(parked.has('f3-falsifier-run')).toBe(true);
  });
});

describe('F4: close() stops every live engine, not just forgetting about it', () => {
  it('tells the underlying session to stop once the whole chain is done', async () => {
    // A real async generator, standing in for the SDK's own session stream: calling
    // `.return()` on it (which is what `Engine.stop()` does to its handle) runs this
    // `finally`, the same way ending a live SDK session would. No live SDK anywhere here.
    let stopped = false;
    const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
      const promptIter = params.prompt as AsyncIterable<unknown>;
      async function* generate() {
        try {
          yield {
            type: 'system', subtype: 'init', session_id: 'sdk-fake-session',
            model: params.options?.model ?? '', cwd: params.options?.cwd ?? '',
            tools: [], slash_commands: [],
          };
          for await (const _pushed of promptIter) {
            yield {
              type: 'assistant', session_id: 'sdk-fake-session',
              message: {
                model: params.options?.model ?? '',
                content: [
                  { type: 'text', text: 'shipped' },
                  { type: 'tool_use', id: 'tu-1', name: 'mcp__forge__forge_done', input: { evidence: 'shipped' } },
                ],
                usage: { input_tokens: 10, output_tokens: 1 },
              },
            };
            yield {
              type: 'user', session_id: 'sdk-fake-session',
              message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: false, content: 'ok' }] },
            };
            yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1 };
            // No `return` here: a real session stays open for the next prompt, and only
            // `Engine.stop()` (calling `.return()` on this generator from outside) ends it.
          }
        } finally {
          stopped = true;
        }
      }
      return generate() as unknown as Query;
    }) as unknown as QueryFn;

    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-f4'), gotchasDir: join(home, 'gotchas-f4'), queryFn: fn,
    });
    await engine.run({ ...REQUEST, run: 'f4-run', env: { PATH: '/usr/bin' } });

    expect(stopped).toBe(false);

    await engine.close();

    expect(stopped).toBe(true);
  });
});

describe('F5: forge_done wins over a ceiling reached on its own closing message', () => {
  it('ends done, with one exec call and zero handoffs, when the tool result and the ceiling-crossing usage share one turn', async () => {
    // The real order: the SDK reports a message's usage together with its content, so a
    // message that carries the forge_done tool call also carries the usage that produced
    // it -- including, when the session is near its ceiling, usage that has already
    // reached it. The tool result arrives after, in the following message. Worker.ts sees
    // both `done` and the ceiling on the same turn and has to pick one: done has to win,
    // or a session that finishes right at its own ceiling would hand off to a successor
    // that has nothing left to do.
    const { fn } = fakeQuery([[{
      text: 'shipped', usage: { input: 60_000, cacheRead: 0, cacheCreation: 0, output: 1 },
      toolUse: { name: 'mcp__forge__forge_done', input: { evidence: 'shipped' } },
    }]]);
    let execCalls = 0;
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-f5'), gotchasDir: join(home, 'gotchas-f5'), queryFn: fn,
    });
    const exec = async (request: { argv: string[] }) => {
      execCalls += 1;
      return {
        ok: true, tail: '', returncode: 0, argv: request.argv, owner: 'f5-run', startedAt: 0, durationMs: 1,
      };
    };
    const worker = new Worker({
      run: 'f5-run',
      brief: '# Goal\n\nDo the thing.\n\n## Verification\n\n```\nnpm run verify\n```\n',
      briefPath: join(home, 'brief.md'), cwd: home, journalPath, engine, exec, maxContext: 60_000,
    });

    const result = await worker.run();

    expect(result.verdict).toBe('done');
    expect(result.handoffs).toBe(0);
    expect(result.sessions).toHaveLength(1);
    expect(execCalls).toBe(1);
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'run.handoff' && e.run === 'f5-run')).toBe(false);
    expect(state.events.some((e) => e.event === 'run.finished' && e.run === 'f5-run' && e['verdict'] === 'done'))
      .toBe(true);
  });
});

describe('a worker session refuses the Monitor tool outright, the same as a websocket Monitor in a brief', () => {
  it('denies a Monitor call regardless of its command, before any rule or ceiling check', async () => {
    const parked = new Map<string, string>();
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-monitor-deny'));
    const hook = buildPreToolUseHook({ run: 'r-mon', goal: 'r-mon', parked, journal, inbox, deliverVia: 'hook' });

    const verdict = await hook({
      toolName: 'Monitor',
      input: { command: 'gh pr checks 37', description: 'watch CI', persistent: true, timeout_ms: 300000 },
      toolUseId: 'tu-mon',
    });

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toMatch(/monitor/i);
    journal.close();
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'permission.denied' && e.run === 'r-mon'
      && e['tool'] === 'Monitor')).toBe(true);
  });
});

describe('P4.7/I4: the Council rules library runs on every Bash and Edit/Write PreToolUse call', () => {
  it('denies a git push to main in a controlled repo, with the gitflow reason, and journals rule.denied', async () => {
    const parked = new Map<string, string>();
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-rules-gitflow'));
    const hook = buildPreToolUseHook({
      run: 'r1', goal: 'r1', parked, journal, inbox, deliverVia: 'hook',
      repoContext: { branch: 'main', controlled: true },
    });

    const verdict = await hook({ toolName: 'Bash', input: { command: 'git push origin main' }, toolUseId: 'tu-1' });

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toMatch(/controlled-code repo/i);
    journal.close();
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'rule.denied' && e.run === 'r1'
      && e['rule'] === 'gitflow')).toBe(true);
  });

  it('denies an Edit whose written text carries a Co-Authored-By: Claude trailer, with the authorship reason', async () => {
    const parked = new Map<string, string>();
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-rules-authorship'));
    const hook = buildPreToolUseHook({ run: 'r2', goal: 'r2', parked, journal, inbox, deliverVia: 'hook' });

    const verdict = await hook({
      toolName: 'Edit',
      input: { file_path: '/tmp/COMMIT_EDITMSG', new_string: 'fix the thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n' },
      toolUseId: 'tu-2',
    });

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toMatch(/authorship/i);
    journal.close();
    const state = replay(journalPath);
    expect(state.events.some((e) => e.event === 'rule.denied' && e.run === 'r2'
      && e['rule'] === 'authorship')).toBe(true);
  });

  it('allows an ordinary read-only Bash call through unchanged', async () => {
    const parked = new Map<string, string>();
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-rules-allow'));
    const hook = buildPreToolUseHook({ run: 'r3', goal: 'r3', parked, journal, inbox, deliverVia: 'hook' });

    const verdict = await hook({ toolName: 'Bash', input: { command: 'npm test' }, toolUseId: 'tu-3' });

    expect(verdict.decision).toBeUndefined();
  });

  it('a park in force still denies first -- the rules check never overrides an existing park', async () => {
    const parked = new Map<string, string>([['r4', 'some-key']]);
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-rules-park-priority'));
    const hook = buildPreToolUseHook({ run: 'r4', goal: 'r4', parked, journal, inbox, deliverVia: 'hook' });

    const verdict = await hook({ toolName: 'Bash', input: { command: 'npm test' }, toolUseId: 'tu-4' });

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('some-key');
  });
});

describe('P4.7/I10: the prose rules never judge source code', () => {
  it('a Write of src/x.ts carrying a decrement and a CLI double-dash flag passes every rule', async () => {
    const parked = new Map<string, string>();
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-i10-code'));
    const hook = buildPreToolUseHook({ run: 'i10a', goal: 'i10a', parked, journal, inbox, deliverVia: 'hook' });

    const verdict = await hook({
      toolName: 'Write',
      input: {
        file_path: '/repo/src/x.ts',
        // The exact shape that tripped the incident: a CLI argv separator (" -- ") plus
        // a bare decrement, both of which the humanizer's EM_DASH regex matches on raw
        // content -- proof this passes only because the sink is now scoped by path, not
        // because the content happens to dodge the pattern.
        content: 'let i = 3;\ni--;\n// pass extra flags after -- to the child process\nrun("build", "--colors=false");\n',
      },
      toolUseId: 'tu-i10a',
    });

    expect(verdict.decision).toBeUndefined();
  });

  it('a Write of docs/x.md carrying an em dash is denied by the humanizer, with the path in the reason', async () => {
    const parked = new Map<string, string>();
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-i10-docs'));
    const hook = buildPreToolUseHook({ run: 'i10b', goal: 'i10b', parked, journal, inbox, deliverVia: 'hook' });

    const verdict = await hook({
      toolName: 'Write',
      input: { file_path: '/repo/docs/x.md', content: 'This is fine -- trust me.' },
      toolUseId: 'tu-i10b',
    });

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toMatch(/humanizer/i);
    expect(verdict.reason).toContain('/repo/docs/x.md');
    journal.close();
    const state = replay(journalPath);
    const denied = state.events.find((e) => e.event === 'rule.denied' && e.run === 'i10b');
    expect(denied?.['rule']).toBe('humanizer');
    expect(denied?.['sink']).toBe('edit');
    expect(denied?.['path']).toBe('/repo/docs/x.md');
  });

  it('I14: an Edit of .claude/goals/x.md carrying an em dash passes every rule; the same text in docs/x.md is denied', async () => {
    const parked = new Map<string, string>();
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-i14-claude'));
    const hook = buildPreToolUseHook({
      run: 'i14a', goal: 'i14a', parked, journal, inbox, deliverVia: 'hook', runCwd: '/repo',
    });

    const claudeVerdict = await hook({
      toolName: 'Edit',
      input: { file_path: '/repo/.claude/goals/x.md', new_string: 'This is fine -- trust me.' },
      toolUseId: 'tu-i14a',
    });
    expect(claudeVerdict.decision).toBeUndefined();

    const docsVerdict = await hook({
      toolName: 'Edit',
      input: { file_path: '/repo/docs/x.md', new_string: 'This is fine -- trust me.' },
      toolUseId: 'tu-i14a-2',
    });
    expect(docsVerdict.decision).toBe('deny');
  });

  it('I14: an Edit of CLAUDE.md, or of a memory/plan file, passes every rule', async () => {
    const parked = new Map<string, string>();
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-i14-memory'));
    const hook = buildPreToolUseHook({ run: 'i14b', goal: 'i14b', parked, journal, inbox, deliverVia: 'hook' });

    const claudeMd = await hook({
      toolName: 'Edit',
      input: { file_path: '/anywhere/CLAUDE.md', new_string: 'This is fine -- trust me.' },
      toolUseId: 'tu-i14b-1',
    });
    expect(claudeMd.decision).toBeUndefined();

    const memory = await hook({
      toolName: 'Edit',
      input: { file_path: '/anywhere/memory-note.md', new_string: 'This is fine -- trust me.' },
      toolUseId: 'tu-i14b-2',
    });
    expect(memory.decision).toBeUndefined();

    const plan = await hook({
      toolName: 'Edit',
      input: { file_path: '/anywhere/plan-goal.md', new_string: 'This is fine -- trust me.' },
      toolUseId: 'tu-i14b-3',
    });
    expect(plan.decision).toBeUndefined();
  });

  it('I14: an Edit of a docs/x.md outside the run\'s own cwd repository passes every rule', async () => {
    const parked = new Map<string, string>();
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-i14-outside'));
    const hook = buildPreToolUseHook({
      run: 'i14c', goal: 'i14c', parked, journal, inbox, deliverVia: 'hook', runCwd: '/repo',
    });

    const outside = await hook({
      toolName: 'Edit',
      input: { file_path: '/somewhere/else/docs/x.md', new_string: 'This is fine -- trust me.' },
      toolUseId: 'tu-i14c-1',
    });
    expect(outside.decision).toBeUndefined();

    // The falsifier: the same doc, inside the run's own repo, is still denied.
    const inside = await hook({
      toolName: 'Edit',
      input: { file_path: '/repo/docs/x.md', new_string: 'This is fine -- trust me.' },
      toolUseId: 'tu-i14c-2',
    });
    expect(inside.decision).toBe('deny');
  });

  it('a gh pr create --body carrying a co-author trailer is denied by authorship', async () => {
    const parked = new Map<string, string>();
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-i10-pr'));
    const hook = buildPreToolUseHook({ run: 'i10c', goal: 'i10c', parked, journal, inbox, deliverVia: 'hook' });

    const trailer = ['Co-Authored', '-By', ': Claude <no', 'reply@anthropic', '.com>'].join('');
    const verdict = await hook({
      toolName: 'Bash',
      input: {
        command: `gh pr create --title "fix" --body "fix the thing\n\n${trailer}"`,
      },
      toolUseId: 'tu-i10c',
    });

    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toMatch(/authorship/i);
    journal.close();
    const state = replay(journalPath);
    const denied = state.events.find((e) => e.event === 'rule.denied' && e.run === 'i10c');
    expect(denied?.['rule']).toBe('authorship');
    expect(denied?.['sink']).toBe('bash');
  });

  it('git push origin feature/x passes gitflow', async () => {
    const parked = new Map<string, string>();
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-i10-gitflow'));
    const hook = buildPreToolUseHook({
      run: 'i10d', goal: 'i10d', parked, journal, inbox, deliverVia: 'hook',
      repoContext: { branch: 'feature/x', controlled: true },
    });

    const verdict = await hook({ toolName: 'Bash', input: { command: 'git push origin feature/x' }, toolUseId: 'tu-i10d' });

    expect(verdict.decision).toBeUndefined();
  });

  it('a deny never ends the run: unlike a park, a ceiling or the kill switch, a rule denial carries no handoff request', async () => {
    const parked = new Map<string, string>();
    const journal = new Journal(journalPath);
    const inbox = new Inbox(join(home, 'inbox-i10-no-handoff'));
    const hook = buildPreToolUseHook({ run: 'i10e', goal: 'i10e', parked, journal, inbox, deliverVia: 'hook' });

    const verdict = await hook({
      toolName: 'Write',
      input: { file_path: '/repo/docs/x.md', content: 'This is fine -- trust me.' },
      toolUseId: 'tu-i10e',
    });

    expect(verdict.decision).toBe('deny');
    // A park/ceiling/kill-switch deny asks the model to write a handoff packet and stop;
    // a rule deny asks it to try something else on its next tool call, so it must never
    // carry that same instruction.
    expect(verdict.additionalContext).toBeUndefined();
  });
});

describe('W1: an auth or rate-limit gh failure is a credential lapse, never a rebase prompt', () => {
  /** Advances its own virtual clock on `sleep` instead of waiting for real. */
  function fakeDriftClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let now = 0;
    return { now: () => now, sleep: async (ms) => { now += ms; } };
  }

  /** Real `gh` output, not a paraphrase: this is what the binary prints with no token. */
  const AUTH_SPECIMEN = 'gh: To get started with GitHub CLI, please run:  gh auth login\n'
    + 'Alternatively, populate the GH_TOKEN environment variable with a GitHub API '
    + 'authentication token.\nnot logged into any GitHub hosts';
  const RATE_LIMIT_SPECIMEN = 'gh: API rate limit exceeded for user ID 1234567. '
    + 'If you reach out to GitHub Support for help, please include the request ID.';

  function pushOnce() {
    return fakeQuery([[{
      text: 'pushed', usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1 },
      toolUse: { name: 'Bash', input: { command: 'git push' } },
    }]]);
  }

  const SPECIMENS = [
    ['an auth failure', 'auth', AUTH_SPECIMEN],
    ['a rate limit', 'rate', RATE_LIMIT_SPECIMEN],
  ] as const;

  for (const [label, slug, specimen] of SPECIMENS) {
    it(`${label} records a credential lapse on the gh account and raises no base-drift ask`, async () => {
      const { fn } = pushOnce();
      const lapses: Array<{ account: string; run: string; pid: number }> = [];
      const engine = new SdkEngine({
        journalPath,
        inboxDir: join(home, `inbox-w1-${slug}`),
        gotchasDir: join(home, `gotchas-w1-${slug}`),
        queryFn: fn,
        checkDrift: async () => readMergeableDetailed(specimen),
        driftClock: fakeDriftClock(),
        credentialHorizon: {
          onLapse: async (account, run, incarnation) => {
            lapses.push({ account, run, pid: incarnation.pid });
            return 'started';
          },
        },
      });
      await engine.run({ ...REQUEST, run: `w1-${slug}`, env: { PATH: '/usr/bin' } });
      await new Promise((resolve) => setImmediate(resolve));

      // Positively: the lapse was recorded, with the gh account and this run's name.
      // Asserting only "no ask was raised" would also pass if the check simply threw.
      // The login flow is for an expired token only. A rate limit is told to Aaron and
      // waited out; taking the login lock for one starves a real auth lapse.
      expect(lapses).toEqual(slug === 'auth'
        ? [{ account: 'github', run: 'w1-auth', pid: process.pid }]
        : []);
      // No base-drift ask. The one entry raised names the credential and never a rebase.
      const open = new Inbox(join(home, `inbox-w1-${slug}`)).open();
      expect(open).toHaveLength(1);
      expect(open[0]?.question).not.toMatch(/rebase/i);
      expect(open[0]?.question).not.toMatch(/base drift/i);
      expect(open[0]?.question).toContain('github');
      // The journal line a person reads. The live probe printed "hit a auth failure"
      // before this assertion existed.
      const note = replay(journalPath).events.find(
        (e) => e.event === 'note' && e.run === `w1-${slug}` && String(e['note']).includes('drift check hit'),
      );
      expect(note?.['note']).toBe(
        `drift check hit ${slug === 'auth' ? 'an auth' : 'a rate-limit'} failure on github; `
        + 'recorded as a credential lapse rather than base drift',
      );
    });
  }

  it('the retry window is not spent on a failure that already explained itself', async () => {
    const { fn } = pushOnce();
    let calls = 0;
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-w1-nowait'), gotchasDir: join(home, 'gotchas-w1-nowait'),
      queryFn: fn,
      checkDrift: async () => { calls++; return readMergeableDetailed(AUTH_SPECIMEN); },
      driftClock: fakeDriftClock(),
      credentialHorizon: { onLapse: async () => 'started' },
    });
    await engine.run({ ...REQUEST, run: 'w1-nowait', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toBe(1);
  });

  it('a genuinely still-computing UNKNOWN still raises the blocker after the whole window', async () => {
    const { fn } = pushOnce();
    let calls = 0;
    let lapsed = false;
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-w1-window'), gotchasDir: join(home, 'gotchas-w1-window'),
      queryFn: fn,
      // Unreadable, unclassifiable output: GitHub has not finished computing the state.
      checkDrift: async () => { calls++; return readMergeableDetailed(''); },
      driftClock: fakeDriftClock(),
      credentialHorizon: { onLapse: async () => { lapsed = true; return 'started'; } },
    });
    await engine.run({ ...REQUEST, run: 'w1-window', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls).toBe(10);
    expect(lapsed).toBe(false);
    const inbox = new Inbox(join(home, 'inbox-w1-window'));
    expect(inbox.open()).toHaveLength(1);
    expect(inbox.open()[0]?.question).toMatch(/could not be read, and unknown is not passing/);
  });

  it('the park lands under credential:<account>, the key the warden tick clears', async () => {
    // A live holder already owns the login lock, so `onLapse` parks rather than starting
    // a second flow -- the branch that reaches the BlockerBoard, and so the branch where
    // the key convention is observable.
    mkdirSync(join(home, 'logins'), { recursive: true });
    writeFileSync(
      join(home, 'logins', 'github.lock'),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      'utf8',
    );
    const raised: Array<{ key: string; run: string }> = [];
    const horizonJournal = new Journal(join(home, 'horizon.jsonl'));
    const blockers = new BlockerBoard({
      journal: horizonJournal,
      actuator: { park: async () => true, resume: async () => {} },
    });
    const watched = {
      raise: async (key: string, what: string, run: string) => {
        raised.push({ key, run });
        await blockers.raise(key, what, run);
      },
      clear: (key: string, message?: string) => blockers.clear(key, message),
      runsFor: (key: string) => blockers.runsFor(key),
    } as unknown as BlockerBoard;
    const horizon = new CredentialHorizon({
      journal: horizonJournal,
      blockers: watched,
      notifyAaron: () => {},
      startFlow: async () => ({ page: 'https://example.test/authorize' }),
      isAlive: () => true,
    });

    const { fn } = pushOnce();
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-w1-key'), gotchasDir: join(home, 'gotchas-w1-key'),
      queryFn: fn,
      checkDrift: async () => readMergeableDetailed(AUTH_SPECIMEN),
      driftClock: fakeDriftClock(),
      credentialHorizon: horizon,
    });
    await engine.run({ ...REQUEST, run: 'w1-key', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));
    horizonJournal.close();

    expect(raised).toEqual([{ key: 'credential:github', run: 'w1-key' }]);
    const openKey = new Inbox(join(home, 'inbox-w1-key')).open();
    expect(openKey).toHaveLength(1);
    expect(openKey[0]?.question).not.toMatch(/rebase/i);
  });
});

describe('W2: the base-drift question names the base branch it is talking about', () => {
  function fakeDriftClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let now = 0;
    return { now: () => now, sleep: async (ms) => { now += ms; } };
  }

  function pushOnce() {
    return fakeQuery([[{
      text: 'pushed', usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1 },
      toolUse: { name: 'Bash', input: { command: 'git push' } },
    }]]);
  }

  it('names the real base for a repo whose base is not main', async () => {
    const { fn } = pushOnce();
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-w2-base'), gotchasDir: join(home, 'gotchas-w2-base'),
      queryFn: fn,
      checkDrift: async () => readMergeableDetailed(
        JSON.stringify({ mergeable: 'CONFLICTING', baseRefName: 'release/1.3.0' }),
      ),
      driftClock: fakeDriftClock(),
    });
    await engine.run({ ...REQUEST, run: 'w2-base', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    const open = new Inbox(join(home, 'inbox-w2-base')).open();
    expect(open).toHaveLength(1);
    expect(open[0]?.question).toContain('release/1.3.0');
    expect(open[0]?.question).not.toContain('the base branch');
  });

  it('an unreadable base names no branch and never guesses main', async () => {
    const { fn } = pushOnce();
    const engine = new SdkEngine({
      journalPath, inboxDir: join(home, 'inbox-w2-nobase'), gotchasDir: join(home, 'gotchas-w2-nobase'),
      queryFn: fn,
      checkDrift: async () => readMergeableDetailed('{"mergeable":"CONFLICTING"}'),
      driftClock: fakeDriftClock(),
    });
    await engine.run({ ...REQUEST, run: 'w2-nobase', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    const open = new Inbox(join(home, 'inbox-w2-nobase')).open();
    expect(open).toHaveLength(1);
    expect(open[0]?.question).toContain('the base branch');
    expect(open[0]?.question).not.toMatch(/\bmain\b/);
  });

  it('a later mergeable read clears the blocker raised under the real base name', async () => {
    const conflicting = JSON.stringify({ mergeable: 'CONFLICTING', baseRefName: 'release/1.3.0' });
    const mergeable = JSON.stringify({ mergeable: 'MERGEABLE', baseRefName: 'release/1.3.0' });
    const inboxDir = join(home, 'inbox-w2-clear');
    const gotchasDir = join(home, 'gotchas-w2-clear');

    const { fn } = pushOnce();
    await new SdkEngine({
      journalPath, inboxDir, gotchasDir, queryFn: fn,
      checkDrift: async () => readMergeableDetailed(conflicting),
      driftClock: fakeDriftClock(),
    }).run({ ...REQUEST, run: 'w2-clear', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(new Inbox(inboxDir).open()).toHaveLength(1);

    const { fn: fn2 } = pushOnce();
    await new SdkEngine({
      journalPath, inboxDir, gotchasDir, queryFn: fn2,
      checkDrift: async () => readMergeableDetailed(mergeable),
      driftClock: fakeDriftClock(),
    }).run({ ...REQUEST, run: 'w2-clear', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(new Inbox(inboxDir).open()).toHaveLength(0);
  });
});

describe('findings from the design critique, held as regressions', () => {
  function fakeDriftClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let now = 0;
    return { now: () => now, sleep: async (ms) => { now += ms; } };
  }

  function pushOnce() {
    return fakeQuery([[{
      text: 'pushed', usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1 },
      toolUse: { name: 'Bash', input: { command: 'git push' } },
    }]]);
  }

  it('a pull request retargeted between two reads still clears the blocker it raised', async () => {
    const inboxDir = join(home, 'inbox-retarget');
    const gotchasDir = join(home, 'gotchas-retarget');

    const { fn } = pushOnce();
    await new SdkEngine({
      journalPath, inboxDir, gotchasDir, queryFn: fn,
      checkDrift: async () => readMergeableDetailed(
        JSON.stringify({ mergeable: 'CONFLICTING', baseRefName: 'develop' }),
      ),
      driftClock: fakeDriftClock(),
    }).run({ ...REQUEST, run: 'retarget', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(new Inbox(inboxDir).open()).toHaveLength(1);

    // The pull request is retargeted from develop to main, so the next read names a
    // different base. The open ask still describes develop, and its key is a hash of
    // that wording, so reconstructing this read's wording never finds it.
    const { fn: fn2 } = pushOnce();
    await new SdkEngine({
      journalPath, inboxDir, gotchasDir, queryFn: fn2,
      checkDrift: async () => readMergeableDetailed(
        JSON.stringify({ mergeable: 'MERGEABLE', baseRefName: 'main' }),
      ),
      driftClock: fakeDriftClock(),
    }).run({ ...REQUEST, run: 'retarget', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(new Inbox(inboxDir).open()).toHaveLength(0);
  });

  it('a credential lapse leaves a question a person can answer, not only a journal note', async () => {
    const inboxDir = join(home, 'inbox-lapse-ask');
    const { fn } = pushOnce();
    await new SdkEngine({
      journalPath, inboxDir, gotchasDir: join(home, 'gotchas-lapse-ask'), queryFn: fn,
      checkDrift: async () => readMergeableDetailed('not logged into any GitHub hosts'),
      driftClock: fakeDriftClock(),
      credentialHorizon: { onLapse: async () => 'started' },
    }).run({ ...REQUEST, run: 'lapse-ask', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    // Nothing in the shipped binary calls CredentialHorizon.tick(), so a park under
    // credential:github has no automatic way back. The board entry is the way back.
    const open = new Inbox(inboxDir).open();
    expect(open).toHaveLength(1);
    expect(open[0]?.question).toContain('github');
    expect(open[0]?.question).not.toMatch(/rebase/i);
  });
});

describe('cross-model review findings, held as regressions', () => {
  function fakeDriftClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let now = 0;
    return { now: () => now, sleep: async (ms) => { now += ms; } };
  }

  function pushOnce() {
    return fakeQuery([[{
      text: 'pushed', usage: { input: 10, cacheRead: 0, cacheCreation: 0, output: 1 },
      toolUse: { name: 'Bash', input: { command: 'git push' } },
    }]]);
  }

  it('a credential ask parks the run it asks about, so "answer this to carry on" is true', async () => {
    const inboxDir = join(home, 'inbox-park');
    const parked = new Map<string, string>();
    const { fn } = pushOnce();
    await new SdkEngine({
      journalPath, inboxDir, gotchasDir: join(home, 'gotchas-park'), queryFn: fn, parked,
      checkDrift: async () => readMergeableDetailed('not logged into any GitHub hosts'),
      driftClock: fakeDriftClock(),
      credentialHorizon: { onLapse: async () => 'started' },
    }).run({ ...REQUEST, run: 'park-run', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    const open = new Inbox(inboxDir).open();
    expect(open).toHaveLength(1);
    // Without this the board says the run is waiting for an answer while the run keeps
    // taking tool calls with a credential that cannot work.
    expect(parked.get('park-run')).toBe(open[0]?.key);
  });

  it('a successor session clears the blocker its predecessor raised for the same goal', async () => {
    const inboxDir = join(home, 'inbox-handoff');
    const gotchasDir = join(home, 'gotchas-handoff');

    const { fn } = pushOnce();
    await new SdkEngine({
      journalPath, inboxDir, gotchasDir, queryFn: fn,
      checkDrift: async () => readMergeableDetailed(
        JSON.stringify({ mergeable: 'CONFLICTING', baseRefName: 'develop' }),
      ),
      driftClock: fakeDriftClock(),
    }).run({ ...REQUEST, run: 'handoff-goal', goal: 'handoff-goal', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(new Inbox(inboxDir).open()).toHaveLength(1);

    // The run hit its ceiling and handed off. The successor carries a new segment name
    // and the same stable goal, rebases, and pushes something mergeable.
    const { fn: fn2 } = pushOnce();
    await new SdkEngine({
      journalPath, inboxDir, gotchasDir, queryFn: fn2,
      checkDrift: async () => readMergeableDetailed(
        JSON.stringify({ mergeable: 'MERGEABLE', baseRefName: 'develop' }),
      ),
      driftClock: fakeDriftClock(),
    }).run({ ...REQUEST, run: 'handoff-goal-2', goal: 'handoff-goal', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(new Inbox(inboxDir).open()).toHaveLength(0);
  });

  it('an ask carries the stable goal, so an answer reaches the session that is live', async () => {
    const inboxDir = join(home, 'inbox-goal-id');
    const { fn } = pushOnce();
    await new SdkEngine({
      journalPath, inboxDir, gotchasDir: join(home, 'gotchas-goal-id'), queryFn: fn,
      checkDrift: async () => readMergeableDetailed('not logged into any GitHub hosts'),
      driftClock: fakeDriftClock(),
      credentialHorizon: { onLapse: async () => 'started' },
    }).run({ ...REQUEST, run: 'goal-id-2', goal: 'goal-id', env: { PATH: '/usr/bin' } });
    await new Promise((resolve) => setImmediate(resolve));

    const open = new Inbox(inboxDir).open();
    expect(open).toHaveLength(1);
    expect(open[0]?.goals).toContain('goal-id');
  });
});

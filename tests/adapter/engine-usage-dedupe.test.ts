/**
 * Proves and fixes a defect in how `Engine` reads the SDK's per-message stream: the
 * Claude Agent SDK delivers one `assistant` message per content block (text, tool_use,
 * etc.), and every one of those messages carries the same `message.id` and the same
 * `usage` object — the usage for the whole turn, repeated verbatim on each block. Before
 * this fix, `Engine` emitted a `usage` event for every one of those messages, so a
 * response with a text block plus a tool call counted its tokens twice.
 */
import { describe, expect, it } from 'vitest';

import type { Query } from '@anthropic-ai/claude-agent-sdk';

import { Engine, type QueryFn } from '../../src/adapter/engine.js';
import type { EngineEvent } from '../../src/adapter/events.js';

function fakeQuery(messages: unknown[]): QueryFn {
  return (() => {
    async function* generate() {
      for (const message of messages) yield message;
    }
    return generate() as unknown as Query;
  }) as unknown as QueryFn;
}

async function run(fn: QueryFn): Promise<EngineEvent[]> {
  const engine = new Engine(fn);
  const seen: EngineEvent[] = [];
  engine.onEvent((event) => seen.push(event));
  engine.start({ cwd: '/', canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as never });
  await new Promise((resolve) => setTimeout(resolve, 10));
  return seen;
}

const usage = {
  input_tokens: 100, cache_read_input_tokens: 5,
  cache_creation_input_tokens: 0, output_tokens: 10,
};

describe('Engine dedupes per-message usage against the SDK\'s repeated-block behaviour', () => {
  it('emits exactly one usage event for two assistant messages sharing message.id', async () => {
    const seen = await run(fakeQuery([
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5', cwd: '/', tools: [], slash_commands: [] },
      {
        type: 'assistant', session_id: 's1',
        message: { id: 'msg_1', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'thinking out loud' }], usage },
      },
      {
        type: 'assistant', session_id: 's1',
        message: { id: 'msg_1', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], usage },
      },
    ]));

    const usageEvents = seen.filter((event) => event.type === 'usage');
    expect(usageEvents).toHaveLength(1);

    const textEvents = seen.filter((event) => event.type === 'assistant-text');
    const toolEvents = seen.filter((event) => event.type === 'tool-use');
    expect(textEvents).toHaveLength(1);
    expect(toolEvents).toHaveLength(1);
  });

  it('emits two usage events for two assistant messages with different message.id', async () => {
    const seen = await run(fakeQuery([
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5', cwd: '/', tools: [], slash_commands: [] },
      {
        type: 'assistant', session_id: 's1',
        message: { id: 'msg_1', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'first turn' }], usage },
      },
      {
        type: 'assistant', session_id: 's1',
        message: { id: 'msg_2', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'second turn' }], usage },
      },
    ]));

    const usageEvents = seen.filter((event) => event.type === 'usage');
    expect(usageEvents).toHaveLength(2);
  });
});

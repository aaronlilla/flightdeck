/**
 * A scripted fake of the SDK's `query` for the Conductor agent's own suites. No model
 * is called (`tests/setup.ts` makes the real `query` throw); what IS real is the tool
 * server: every scripted tool call goes through the agent's own `createSdkMcpServer`
 * instance over an in-memory MCP transport, so zod validation and the handler behind
 * each tool run exactly as they would under the SDK.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

import type { QueryFn } from '../../../src/adapter/engine.js';

export interface ScriptedToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export interface ScriptedTurn {
  tools?: ScriptedToolCall[];
  /** The assistant's final text, or a function of the tool results seen this turn. */
  reply: string | ((results: string[]) => string);
  usage?: { input: number; cacheRead: number; cacheCreation: number; output: number };
  /** End the turn on an error subtype with no text. */
  errorSubtype?: string;
}

export interface ToolCallRecord {
  tool: string;
  input: Record<string, unknown>;
  result: string;
}

const DEFAULT_USAGE = { input: 200, cacheRead: 0, cacheCreation: 0, output: 40 };

/** One `query` per session; the same script answers every prompt in order, and the
 *  last turn repeats when the script runs out. */
export function scriptedQuery(script: ScriptedTurn[], sessionId = 'conductor-fake-session') {
  const calls: Array<{ options: Options }> = [];
  const prompts: string[] = [];
  const toolCalls: ToolCallRecord[] = [];
  let sessions = 0;
  const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    calls.push({ options: params.options as Options });
    sessions += 1;
    const thisSession = sessions === 1 ? sessionId : `${sessionId}-${sessions}`;
    const promptIter = params.prompt as AsyncIterable<{ message?: { content?: unknown } }>;
    const model = params.options?.model ?? '';
    async function* generate() {
      yield {
        type: 'system', subtype: 'init', session_id: thisSession, model,
        cwd: params.options?.cwd ?? '', tools: [], slash_commands: [],
      };
      const servers = (params.options?.mcpServers ?? {}) as Record<string, { instance?: { connect: (t: unknown) => Promise<void> } }>;
      const conductor = servers['conductor']?.instance;
      let client: Client | undefined;
      if (conductor) {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await conductor.connect(serverTransport);
        client = new Client({ name: 'conductor-fake', version: '0' });
        await client.connect(clientTransport);
      }
      let index = 0;
      for await (const pushed of promptIter) {
        const content = pushed?.message?.content;
        prompts.push(typeof content === 'string' ? content : JSON.stringify(content));
        const turn = script[Math.min(index, script.length - 1)]!;
        index += 1;
        const usage = turn.usage ?? DEFAULT_USAGE;
        const sdkUsage = {
          input_tokens: usage.input, cache_read_input_tokens: usage.cacheRead,
          cache_creation_input_tokens: usage.cacheCreation, output_tokens: usage.output,
        };
        const results: string[] = [];
        for (const step of turn.tools ?? []) {
          const id = `tu-${toolCalls.length + 1}`;
          yield {
            type: 'assistant', session_id: thisSession,
            message: { model, content: [{ type: 'tool_use', id, name: `mcp__conductor__${step.tool}`, input: step.input }], usage: sdkUsage },
          };
          if (!client) throw new Error('the scripted turn calls a tool but no conductor MCP server was passed');
          const outcome = await client.callTool({ name: step.tool, arguments: step.input });
          const text = (outcome.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? '').join('');
          results.push(text);
          toolCalls.push({ tool: step.tool, input: step.input, result: text });
          yield {
            type: 'user', session_id: thisSession,
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] },
          };
        }
        if (turn.errorSubtype) {
          yield { type: 'result', subtype: turn.errorSubtype, is_error: true, duration_ms: 5, total_cost_usd: 0 };
          continue;
        }
        const replyText = typeof turn.reply === 'function' ? turn.reply(results) : turn.reply;
        yield {
          type: 'assistant', session_id: thisSession,
          message: { model, content: [{ type: 'text', text: replyText }], usage: sdkUsage },
        };
        yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 5, total_cost_usd: 0 };
      }
    }
    return generate() as unknown as ReturnType<QueryFn>;
  }) as QueryFn;
  return { fn, calls, prompts, toolCalls };
}

/** A `query` that throws the moment it is called: the session cannot open at all. */
export function refusingQuery(message = 'fleet login expired') {
  const fn = (() => { throw new Error(message); }) as unknown as QueryFn;
  return { fn };
}

/** A `query` whose session never answers once the prompt lands. */
export function hangingQuery() {
  const calls: Array<{ options: Options }> = [];
  const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    calls.push({ options: params.options as Options });
    async function* generate() {
      yield {
        type: 'system', subtype: 'init', session_id: 'conductor-hang', model: params.options?.model ?? '',
        cwd: params.options?.cwd ?? '', tools: [], slash_commands: [],
      };
      await new Promise(() => {});
    }
    return generate() as unknown as ReturnType<QueryFn>;
  }) as QueryFn;
  return { fn, calls };
}

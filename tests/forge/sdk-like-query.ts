/**
 * A fake SDK `query` that honours the PreToolUse hook the way the real SDK does.
 *
 * It stands in for the SDK's side of the hook contract and nothing more: it emits each
 * scripted tool call, runs the real hook `buildOptions` registered, and then does what the
 * SDK does with the hook's output. `continue: false` ends the turn right there, the shape
 * every Monitor refusal in the fleet journal shows (`tool.end`, `result`, `turn.end` inside
 * 640 ms of the deny, no model turn between); otherwise a refusal goes back to the model as
 * an error tool result and the model's next scripted step in the same turn runs.
 */
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';

import type { QueryFn } from '../../src/adapter/engine.js';

export interface ToolStep {
  name: string;
  input?: Record<string, unknown>;
  /** Runs after the hook answers this step, before the next step: a park cleared, say. */
  after?: () => void;
}

type HookFn = (input: unknown, toolUseId: string, ctx: unknown) => Promise<{
  continue?: boolean;
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}>;

export function sdkLikeQuery(script: ToolStep[][]) {
  const ran: string[] = [];
  const refusals: string[] = [];
  const prompts: string[] = [];
  let turnsEnded = 0;
  const fn = ((params: { prompt: AsyncIterable<unknown>; options?: Options }) => {
    const hook = (params.options as unknown as { hooks?: { PreToolUse?: Array<{ hooks: HookFn[] }> } })
      .hooks?.PreToolUse?.[0]?.hooks[0];
    async function* generate() {
      yield {
        type: 'system', subtype: 'init', session_id: 'sdk-fake', model: '', cwd: '', tools: [],
        slash_commands: [],
      };
      let turn = 0;
      for await (const pushed of params.prompt) {
        const content = (pushed as { message?: { content?: unknown } }).message?.content;
        prompts.push(typeof content === 'string' ? content : JSON.stringify(content));
        const steps = script[turn] ?? [];
        turn += 1;
        for (const [index, step] of steps.entries()) {
          const id = `tu-${turn}-${index}`;
          yield {
            type: 'assistant', session_id: 'sdk-fake',
            message: {
              id: `msg-${turn}-${index}`, model: 'claude-sonnet-5',
              content: [{ type: 'tool_use', id, name: step.name, input: step.input ?? {} }],
              usage: { input_tokens: 10, output_tokens: 1 },
            },
          };
          const output = await hook?.(
            { hook_event_name: 'PreToolUse', tool_name: step.name, tool_input: step.input ?? {} }, id, {},
          );
          const denied = output?.hookSpecificOutput?.permissionDecision === 'deny';
          if (denied) refusals.push(`${step.name}: ${output?.hookSpecificOutput?.permissionDecisionReason ?? ''}`);
          step.after?.();
          yield {
            type: 'user', session_id: 'sdk-fake',
            message: {
              content: [{ type: 'tool_result', tool_use_id: id, is_error: denied, content: denied ? 'refused' : 'ok' }],
            },
          };
          if (output?.continue === false) break;
          if (!denied) ran.push(step.name);
        }
        turnsEnded += 1;
        yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1 };
      }
    }
    return generate() as unknown as Query;
  }) as unknown as QueryFn;
  return { fn, ran, refusals, prompts, turnsEnded: () => turnsEnded };
}

/** A one-message streaming prompt, for driving `sdkLikeQuery` without an `Engine`. */
export async function* onePrompt(text: string) {
  yield { type: 'user', message: { role: 'user', content: text } };
}

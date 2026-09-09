/**
 * What the rest of flightdeck sees instead of SDK message types.
 *
 * The SDK's message union has more than thirty members and changes with the
 * product. The cockpit and the kernel only care about a handful of things, so
 * the adapter narrows the union here. Anything the adapter does not recognise
 * becomes an `unknown-message` event rather than being dropped, because a
 * silently discarded message is the kind of gap that reads as working.
 */
export type EngineEvent =
  | {
      type: 'session-started';
      sessionId: string;
      model: string;
      cwd: string;
      tools: string[];
      slashCommands: string[];
    }
  | { type: 'assistant-text'; text: string; model: string; sessionId: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool-use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool-result'; id: string; isError: boolean; text: string }
  | {
      type: 'turn-complete';
      subtype: string;
      isError: boolean;
      durationMs: number;
      costUsd: number | null;
      /** Tokens the turn left unused, when the SDK reported them. */
      contextRemaining: number | null;
    }
  | {
      type: 'usage';
      model: string;
      input: number;
      cacheRead: number;
      cacheCreation: number;
      output: number;
      /** Set when this message belongs to a subagent's own Task tool call, not the main
       *  loop. A ceiling reads only the main loop's own context; a subagent's usage is
       *  its own conversation and does not belong in that number. */
      parentToolUseId: string | null;
    }
  | {
      /**
       * The SDK result message's own `modelUsage` map (main loop, Task subagents,
       * sidechains and internal calls, per its own doc comment), emitted once per
       * segment alongside `turn-complete`. This is the Governor's burn-ledger source
       * (`src/forge/governor.ts`'s `buildBurnLedger`), kept separate from the per-message
       * `usage` event above rather than replacing it: the two are reconciled against
       * each other, not merged.
       */
      type: 'result-usage';
      modelUsage: Record<string, {
        input: number; cacheRead: number; cacheCreation: number; output: number; costUsd: number;
      }>;
    }
  | { type: 'compact-boundary'; trigger: string }
  | {
      /**
       * The SDK's `rate_limit_event`, sent for claude.ai subscription sessions when the
       * plan window state changes. On an ordinary turn it carries `status` and the
       * window's reset time and nothing else; `utilization` arrives only when the
       * product includes it. `resetsAt` is milliseconds since the epoch here (the SDK
       * sends seconds), or null when the event named no reset.
       */
      type: 'rate-limit';
      status: 'allowed' | 'allowed_warning' | 'rejected';
      window: string | null;
      utilization: number | null;
      resetsAt: number | null;
    }
  | { type: 'engine-error'; message: string; fatal: boolean }
  | { type: 'stderr'; text: string }
  | { type: 'unknown-message'; kind: string };

export type EngineListener = (event: EngineEvent) => void;

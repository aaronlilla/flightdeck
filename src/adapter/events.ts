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
  | { type: 'compact-boundary'; trigger: string }
  | { type: 'engine-error'; message: string; fatal: boolean }
  | { type: 'stderr'; text: string }
  | { type: 'unknown-message'; kind: string };

export type EngineListener = (event: EngineEvent) => void;

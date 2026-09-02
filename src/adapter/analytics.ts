/**
 * Amplitude Agent Analytics bootstrap.
 *
 * Lives in the adapter because the tracker consumes raw SDK messages, and the
 * adapter is the only layer that sees them. Content mode is metadata_only on
 * purpose: tokens, latency, model and cost leave the machine, conversation
 * text does not. Code from the session must never reach a third-party
 * analytics store.
 *
 * The API key has a compiled-in default for the same reason the React Native
 * app compiles in its Sentry DSN: a shell without the env var should report,
 * not silently go dark. `AMPLITUDE_AI_API_KEY` overrides it, and an empty
 * string turns tracking off. An Amplitude ingestion key is a public client
 * key, not a secret.
 */
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';

import { AIConfig, AmplitudeAI, ContentMode, type Session } from '@amplitude/ai';
import { ClaudeAgentSDKTracker } from '@amplitude/ai/integrations/claude-agent-sdk';

export type { Session };

export const DEFAULT_AI_API_KEY = 'ded235d607473f3fcc95fc80524b6a75';

export const resolveAiApiKey = (
  env: Record<string, string | undefined> = process.env,
): string =>
  env['AMPLITUDE_AI_API_KEY'] !== undefined
    ? env['AMPLITUDE_AI_API_KEY']
    : DEFAULT_AI_API_KEY;

/**
 * The slice of AmplitudeAI the adapter touches. MockAmplitudeAI satisfies it,
 * which is what lets the verify test run without a network.
 */
export interface AmplitudeClient {
  agent(
    agentId: string,
    opts?: { description?: string },
  ): {
    session(opts?: {
      userId?: string | null;
      sessionId?: string | null;
      idleTimeoutMinutes?: number | null;
    }): Session;
  };
  /** Typed loosely because AmplitudeAI declares its flush as `unknown`. */
  flush(): unknown;
}

export interface Analytics {
  session: Session;
  tracker: ClaudeAgentSDKTracker;
  flush(): Promise<void>;
}

const safeUsername = (): string => {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
};

/**
 * Null when tracking is switched off via an empty `AMPLITUDE_AI_API_KEY`.
 *
 * One analytics session per engine start: a flightdeck run is one
 * conversation. `idleTimeoutMinutes: -1` defers enrichment to the explicit
 * Session End that `session.run()` emits when the engine stops, since turns in
 * an interactive cockpit can be hours apart.
 */
export function createAnalytics(client?: AmplitudeClient): Analytics | null {
  const apiKey = resolveAiApiKey();
  if (!apiKey) return null;
  const ai: AmplitudeClient =
    client ??
    new AmplitudeAI({
      apiKey,
      config: new AIConfig({ contentMode: ContentMode.METADATA_ONLY }),
    });
  const agent = ai.agent('flightdeck', {
    description: 'Terminal cockpit for the Claude Agent SDK',
  });
  const session = agent.session({
    userId: safeUsername(),
    sessionId: randomUUID(),
    idleTimeoutMinutes: -1,
  });
  const tracker = new ClaudeAgentSDKTracker({ defaultProvider: 'anthropic' });
  return {
    session,
    tracker,
    flush: async () => {
      await ai.flush();
    },
  };
}

/** The envelope shape `query()` yields: a type tag around the API message. */
export interface SdkMessageEnvelope {
  type: string;
  message?: unknown;
}

/**
 * Feed one stream message to the tracker.
 *
 * The tracker dispatches on `msg.role`, which lives on the INNER message, not
 * on the SDK envelope. Passing the envelope makes every event silently vanish,
 * so the unwrap happens here, once, where the verify test can prove it.
 *
 * User envelopes are skipped: the human turn is tracked at send time by
 * `trackUserTurn`, and the user-role messages in the stream are tool results,
 * which the PostToolUse hook already covers.
 */
export function trackEnvelope(
  session: Session,
  tracker: ClaudeAgentSDKTracker,
  envelope: SdkMessageEnvelope,
): void {
  if (envelope.type === 'assistant' && envelope.message) {
    tracker.process(session, envelope.message);
  }
}

/**
 * One human turn: a fresh trace, then the user message. Without the new trace
 * every event in the run collapses into a single turn in the session viewer.
 */
export function trackUserTurn(session: Session, text: string): void {
  session.newTrace();
  session.trackUserMessage(text);
}

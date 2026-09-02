/**
 * Proves the Amplitude Agent Analytics wiring end to end against the SDK's
 * deterministic mock: the user turn helper, the envelope unwrap, the data
 * quality fields Agent Analytics needs, and the session close.
 *
 * The envelope unwrap is the load-bearing assertion. The tracker dispatches on
 * `msg.role`, which the SDK's stream envelope does not carry, so feeding it
 * envelopes tracks nothing and fails silently in production.
 */
import { describe, expect, it } from 'vitest';

import {
  AIConfig,
  ContentMode,
  MockAmplitudeAI,
  PROP_INPUT_TOKENS,
  PROP_MODEL_NAME,
  PROP_OUTPUT_TOKENS,
  PROP_PROVIDER,
  PROP_SESSION_ID,
} from '@amplitude/ai';

import {
  DEFAULT_AI_API_KEY,
  createAnalytics,
  resolveAiApiKey,
  trackEnvelope,
  trackUserTurn,
} from '../src/adapter/analytics.ts';

describe('resolveAiApiKey', () => {
  it('falls back to the compiled-in key when the env sets none', () => {
    expect(resolveAiApiKey({})).toBe(DEFAULT_AI_API_KEY);
  });

  it('returns an empty string when the env opts out, disabling tracking', () => {
    expect(resolveAiApiKey({ AMPLITUDE_AI_API_KEY: '' })).toBe('');
  });

  it('prefers a key the env supplies', () => {
    expect(resolveAiApiKey({ AMPLITUDE_AI_API_KEY: 'override' })).toBe('override');
  });
});

describe('flightdeck session wiring', () => {
  const runSession = async () => {
    const mock = new MockAmplitudeAI(
      new AIConfig({ contentMode: ContentMode.METADATA_ONLY }),
    );
    const analytics = createAnalytics(mock);
    if (!analytics) throw new Error('analytics disabled in test env');
    const sessionId = analytics.session.sessionId;

    await analytics.session.run(async (s) => {
      trackUserTurn(s, 'verify the amplitude wiring');
      trackEnvelope(s, analytics.tracker, {
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: [{ type: 'text', text: 'wired' }],
          usage: { input_tokens: 42, output_tokens: 96 },
        },
      });
    });

    return { mock, sessionId };
  };

  it('tracks the user turn and closes the session', async () => {
    const { mock, sessionId } = await runSession();
    mock.assertEventTracked('[Agent] User Message');
    mock.assertSessionClosed(sessionId);
  });

  it('unwraps the SDK envelope into an AI response with the data quality fields', async () => {
    const { mock } = await runSession();
    const aiEvents = mock.getEvents('[Agent] AI Response');
    expect(aiEvents.length).toBe(1);
    for (const e of aiEvents) {
      const p = (e.event_properties ?? {}) as Record<string, unknown>;
      expect(e.user_id || e.device_id).toBeTruthy();
      expect(p[PROP_SESSION_ID]).toBeTruthy();
      expect(p[PROP_MODEL_NAME]).toBe('claude-sonnet-4-20250514');
      expect(p[PROP_PROVIDER]).toBe('anthropic');
      expect(p[PROP_INPUT_TOKENS]).toBe(42);
      expect(p[PROP_OUTPUT_TOKENS]).toBe(96);
    }
  });

  it('ignores user envelopes so send-time tracking cannot duplicate', async () => {
    const mock = new MockAmplitudeAI(
      new AIConfig({ contentMode: ContentMode.METADATA_ONLY }),
    );
    const analytics = createAnalytics(mock);
    if (!analytics) throw new Error('analytics disabled in test env');
    await analytics.session.run(async (s) => {
      trackEnvelope(s, analytics.tracker, {
        type: 'user',
        message: { role: 'user', content: 'echoed back by the stream' },
      });
    });
    expect(mock.getEvents('[Agent] User Message').length).toBe(0);
  });
});

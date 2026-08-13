/**
 * SDK message to EngineEvent translation, kept pure so it can be tested
 * against recorded frames without spawning a session or spending anything.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { EngineEvent } from './events.ts';

export function translateMessage(message: SDKMessage): EngineEvent[] {
  const events: EngineEvent[] = [];

  switch (message.type) {
    case 'system': {
      if (message.subtype === 'init') {
        events.push({
          type: 'session-started',
          sessionId: message.session_id,
          model: message.model,
          cwd: message.cwd,
          tools: message.tools ?? [],
          slashCommands: message.slash_commands ?? [],
        });
        break;
      }
      // Compaction arrives as a system subtype rather than its own message
      // type. It matters to the interface because the conversation the user is
      // looking at silently loses its earlier turns at this point.
      if (message.subtype === 'compact_boundary') {
        events.push({
          type: 'compact-boundary',
          trigger: message.compact_metadata?.trigger ?? 'unknown',
        });
      }
      break;
    }

    case 'assistant': {
      const model = message.message.model ?? '';
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          events.push({
            type: 'assistant-text',
            text: block.text,
            model,
            sessionId: message.session_id,
          });
        } else if (block.type === 'thinking') {
          events.push({ type: 'thinking', text: block.thinking });
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'tool-use',
            id: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          });
        }
      }
      if (message.error) {
        events.push({
          type: 'engine-error',
          message: `assistant turn failed: ${message.error}`,
          fatal: message.error === 'authentication_failed',
        });
      }
      break;
    }

    case 'user': {
      const content = message.message.content;
      if (typeof content === 'string' || !Array.isArray(content)) break;
      for (const block of content) {
        if (typeof block === 'object' && block !== null && block.type === 'tool_result') {
          events.push({
            type: 'tool-result',
            id: block.tool_use_id,
            isError: block.is_error === true,
            text: renderToolResult(block.content),
          });
        }
      }
      break;
    }

    case 'result': {
      const costUsd =
        typeof (message as { total_cost_usd?: unknown }).total_cost_usd === 'number'
          ? (message as { total_cost_usd: number }).total_cost_usd
          : null;
      events.push({
        type: 'turn-complete',
        subtype: message.subtype,
        isError: message.is_error === true,
        durationMs: message.duration_ms ?? 0,
        costUsd,
        contextRemaining: readContextRemaining(message),
      });
      break;
    }

    default: {
      // Never dropped silently. An unrecognised frame is reported as unknown so
      // that a gap in this translation shows up instead of looking like quiet.
      events.push({ type: 'unknown-message', kind: message.type });
    }
  }

  return events;
}

/** The model that answered, when the frame carries one. */
export function servingModelOf(message: SDKMessage): string | null {
  if (message.type !== 'assistant') return null;
  return message.message.model ?? null;
}

export function sessionIdOf(message: SDKMessage): string | null {
  const id = (message as { session_id?: unknown }).session_id;
  return typeof id === 'string' && id ? id : null;
}

function renderToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) {
        return String((part as { text: unknown }).text ?? '');
      }
      return '';
    })
    .join('');
}

/**
 * Tokens left in the window, when the result frame carries them. The field is
 * optional across SDK versions, so a missing value reads as unknown rather
 * than as zero, which would render as an empty context meter.
 */
function readContextRemaining(message: unknown): number | null {
  if (!message || typeof message !== 'object') return null;
  const usage = (message as { usage?: Record<string, unknown> }).usage;
  if (!usage) return null;
  const remaining = usage['context_window_remaining'] ?? usage['remaining_tokens'];
  return typeof remaining === 'number' ? remaining : null;
}

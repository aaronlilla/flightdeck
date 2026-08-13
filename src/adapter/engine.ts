/**
 * The only module in flightdeck that imports the Claude Agent SDK.
 *
 * Everything above this file works in flightdeck's own types, so an SDK API
 * change lands here and nowhere else. The adapter owns three things: the
 * streaming input queue, the translation from SDK messages to EngineEvent, and
 * the control calls that make phase routing possible in the first place.
 */
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk';

import type { EngineEvent, EngineListener } from './events.ts';
import { PushStream } from './stream.ts';

export interface EngineConfig {
  cwd: string;
  /** Model to open the session on. */
  model?: string;
  permissionMode?: PermissionMode;
  /** Called by the engine whenever a tool needs a decision. */
  canUseTool: CanUseTool;
  /** Resume an existing session by id instead of starting a new one. */
  resume?: string;
  /**
   * Where configuration comes from. Defaults to the same three sources the CLI
   * reads, which is what carries CLAUDE.md, skills and agents across unchanged.
   */
  settingSources?: SettingSource[];
  /** Extra agent definitions merged in from overlays. */
  agents?: Options['agents'];
}

export class Engine {
  private readonly input = new PushStream<SDKUserMessage>();
  private readonly listeners = new Set<EngineListener>();
  private handle: Query | null = null;
  private pump: Promise<void> | null = null;

  private sessionId: string | null = null;
  private lastServingModel: string | null = null;

  onEvent(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // A rendering fault must not take down the message pump, or one bad
        // frame would end the session.
        process.stderr.write(`flightdeck: listener threw: ${String(error)}\n`);
      }
    }
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /** The model that answered the most recent turn, which is not always the one asked for. */
  get servingModel(): string | null {
    return this.lastServingModel;
  }

  start(config: EngineConfig): void {
    if (this.handle) throw new Error('engine already started');

    const options: Options = {
      cwd: config.cwd,
      canUseTool: config.canUseTool,
      settingSources: config.settingSources ?? ['user', 'project', 'local'],
      includePartialMessages: false,
      stderr: (data: string) => this.emit({ type: 'stderr', text: data }),
    };
    if (config.model) options.model = config.model;
    if (config.permissionMode) options.permissionMode = config.permissionMode;
    if (config.resume) options.resume = config.resume;
    if (config.agents) options.agents = config.agents;

    this.handle = query({ prompt: this.input, options });
    this.pump = this.drain(this.handle);
  }

  private async drain(handle: Query): Promise<void> {
    try {
      for await (const message of handle) {
        this.translate(message);
      }
    } catch (error) {
      this.emit({
        type: 'engine-error',
        message: error instanceof Error ? error.message : String(error),
        fatal: true,
      });
    }
  }

  private translate(message: SDKMessage): void {
    switch (message.type) {
      case 'system': {
        if (message.subtype === 'init') {
          this.sessionId = message.session_id;
          this.emit({
            type: 'session-started',
            sessionId: message.session_id,
            model: message.model,
            cwd: message.cwd,
            tools: message.tools ?? [],
            slashCommands: message.slash_commands ?? [],
          });
          return;
        }
        // Compaction arrives as a system subtype rather than its own message
        // type. It matters to the interface because the conversation the user
        // is looking at silently loses its earlier turns at this point.
        if (message.subtype === 'compact_boundary') {
          this.emit({
            type: 'compact-boundary',
            trigger: message.compact_metadata?.trigger ?? 'unknown',
          });
        }
        return;
      }

      case 'assistant': {
        this.sessionId = message.session_id;
        const model = message.message.model;
        if (model) this.lastServingModel = model;
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text) {
            this.emit({
              type: 'assistant-text',
              text: block.text,
              model: model ?? '',
              sessionId: message.session_id,
            });
          } else if (block.type === 'thinking') {
            this.emit({ type: 'thinking', text: block.thinking });
          } else if (block.type === 'tool_use') {
            this.emit({
              type: 'tool-use',
              id: block.id,
              name: block.name,
              input: (block.input ?? {}) as Record<string, unknown>,
            });
          }
        }
        if (message.error) {
          this.emit({
            type: 'engine-error',
            message: `assistant turn failed: ${message.error}`,
            fatal: message.error === 'authentication_failed',
          });
        }
        return;
      }

      case 'user': {
        const content = message.message.content;
        if (typeof content === 'string' || !Array.isArray(content)) return;
        for (const block of content) {
          if (typeof block === 'object' && block !== null && block.type === 'tool_result') {
            this.emit({
              type: 'tool-result',
              id: block.tool_use_id,
              isError: block.is_error === true,
              text: renderToolResult(block.content),
            });
          }
        }
        return;
      }

      case 'result': {
        const costUsd =
          typeof (message as { total_cost_usd?: unknown }).total_cost_usd === 'number'
            ? (message as { total_cost_usd: number }).total_cost_usd
            : null;
        this.emit({
          type: 'turn-complete',
          subtype: message.subtype,
          isError: message.is_error === true,
          durationMs: message.duration_ms ?? 0,
          costUsd,
          contextRemaining: readContextRemaining(message),
        });
        return;
      }

      default: {
        this.emit({ type: 'unknown-message', kind: message.type });
      }
    }
  }

  /** Queue a message from the human. */
  send(text: string): void {
    if (!this.handle) throw new Error('engine not started');
    const message = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId ?? '',
      origin: { kind: 'human' },
    } as unknown as SDKUserMessage;
    this.input.push(message);
  }

  /**
   * Switch the model mid-session.
   *
   * This one call is why flightdeck exists. The hook protocol it replaces could
   * only refuse a turn and ask the human to run a command.
   */
  async setModel(model: string | undefined): Promise<void> {
    if (!this.handle) throw new Error('engine not started');
    await this.handle.setModel(model);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.handle) throw new Error('engine not started');
    await this.handle.setPermissionMode(mode);
  }

  async interrupt(): Promise<void> {
    if (!this.handle) return;
    await this.handle.interrupt();
  }

  async stop(): Promise<void> {
    this.input.end();
    try {
      await this.handle?.return(undefined);
    } catch {
      // Returning into a generator that already finished is not an error worth
      // reporting during shutdown.
    }
    await this.pump;
    this.handle = null;
  }
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
 * Tokens left in the window, when the result message carries them. The field
 * is optional across SDK versions, so a missing value reads as unknown rather
 * than as zero.
 */
function readContextRemaining(message: unknown): number | null {
  if (!message || typeof message !== 'object') return null;
  const usage = (message as { usage?: Record<string, unknown> }).usage;
  if (!usage) return null;
  const remaining = usage['context_window_remaining'] ?? usage['remaining_tokens'];
  return typeof remaining === 'number' ? remaining : null;
}

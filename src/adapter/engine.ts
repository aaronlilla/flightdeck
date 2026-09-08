/**
 * The only module in flightdeck that imports the Claude Agent SDK.
 *
 * Everything above this file works in flightdeck's own types, so an SDK API
 * change lands here and nowhere else. The adapter owns three things: the
 * streaming input queue, the translation from SDK messages to EngineEvent, and
 * the control calls that make phase routing possible in the first place.
 */
import {
  createSdkMcpServer,
  listSessions,
  query,
  tool,
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { EngineEvent, EngineListener } from './events.ts';
import { PushStream } from './stream.ts';

export interface EngineConfig {
  cwd: string;
  /** Model to open the session on. */
  model?: string;
  permissionMode?: PermissionMode;
  /** Called when a tool needs a permission decision, which is the human's. */
  canUseTool: CanUseTool;
  /**
   * Called for every tool call, before it runs.
   *
   * This is where policy belongs. A permission rule that already allows a tool
   * skips canUseTool entirely, so anything that has to see all traffic has to
   * be here instead.
   */
  onToolCall?: (call: {
    toolName: string;
    input: Record<string, unknown>;
    toolUseId: string;
  }) => Promise<PreToolVerdict> | PreToolVerdict;
  /** Resume an existing session by id instead of starting a new one. */
  resume?: string;
  /**
   * Where configuration comes from. Defaults to the same three sources the CLI
   * reads, which is what carries CLAUDE.md, skills and agents across unchanged.
   */
  settingSources?: SettingSource[];
  /** Extra agent definitions merged in from overlays. */
  agents?: Options['agents'];
  /**
   * The environment the session's subprocess runs with.
   *
   * Passed through for the Forge runner, which strips nine inherited CLAUDE names and
   * ANTHROPIC_API_KEY before spawning a worker. Inheriting them means the child saves no
   * transcript, and a worker with no transcript is one nothing can read afterwards.
   */
  env?: NodeJS.ProcessEnv;
  /** A hard turn cap, taken from the run's class rather than asked for in the prompt. */
  maxTurns?: number;
  /** Tool servers the session may reach. The runner registers exactly one. */
  mcpServers?: Options['mcpServers'];
  /**
   * Tools that are auto-allowed without a permission prompt. This does NOT restrict
   * which tools the model can reach -- the SDK's own doc for `allowedTools` says so
   * explicitly ("To restrict which tools are available, use the `tools` option
   * instead"), and a `bypassPermissions` session skips the permission layer this field
   * belongs to entirely. `[]` here means no tool skips a prompt, never "no tools" --
   * see `tools` below for the field that actually disables tools.
   */
  allowedTools?: string[];
  /**
   * The base set of built-in tools the session may even attempt. `[]` disables every
   * built-in tool outright (the SDK's own words: "Disable all built-in tools"),
   * regardless of `permissionMode` or `canUseTool` -- unlike `allowedTools`, this is
   * not a permission decision the model can be routed around. The reasoner seam
   * (`reasoner-claude.ts`) sets this, because its own `allowedTools: []` was found
   * (2026-09-07) to still let a lens session run a real `Bash`/`Read` call under
   * `bypassPermissions`, burning its one bounded turn on the tool call instead of an
   * answer and ending the session with no text at all.
   */
  tools?: string[];
  /** How much effort the model puts into its response: the class's own choice, not the
   *  SDK's per-model default. */
  effort?: Options['effort'];
  /**
   * Overrides the SDK's default `claude_code` system-prompt preset (which loads
   * CLAUDE.md, skills and hooks context) with a plain string of the caller's own.
   * Left unset, every session up to now has taken the default preset; a bounded,
   * isolated call (the reasoner seam) sets this so it never pays for, or gets steered
   * by, an agent system prompt it did not ask for.
   */
  systemPrompt?: Options['systemPrompt'];
}

/** One earlier session, reduced to what a picker needs to show. */
export interface SessionSummary {
  sessionId: string;
  summary: string;
  lastModified: number;
}

/**
 * Earlier sessions for a directory, newest first.
 *
 * Wrapped here rather than called from the interface, because this file is the
 * only one allowed to know the SDK exists. Returns nothing on failure: a
 * picker that cannot read the store has no sessions to offer, and that is worth
 * saying rather than throwing into a render.
 */
export async function listRecentSessions(cwd: string, limit = 10): Promise<SessionSummary[]> {
  try {
    const sessions = await listSessions({ dir: cwd, limit });
    return sessions.map((session) => ({
      sessionId: session.sessionId,
      summary: session.customTitle || session.summary || session.firstPrompt || '(no title)',
      lastModified: session.lastModified,
    }));
  } catch {
    return [];
  }
}

/** What a PreToolUse inspection may answer. */
export interface PreToolVerdict {
  decision: 'deny' | 'ask' | undefined;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  /** Text delivered to the model alongside this tool call, regardless of the decision. */
  additionalContext?: string;
}

/** The SDK's own session-starting function, matched so a specimen can inject a fake. */
export type QueryFn = typeof query;

/**
 * Translate flightdeck's configuration into the SDK's options.
 *
 * Separate from `start` so the wiring can be asserted without spawning a
 * session. The part worth asserting is that `onToolCall` becomes a PreToolUse
 * hook: it is the only interception point that sees a tool an existing
 * permission rule already allows, and guards that are never called look
 * exactly like guards that found nothing.
 */
export function buildOptions(
  config: EngineConfig,
  onStderr: (data: string) => void = () => {},
): Options {
  const options: Options = {
    cwd: config.cwd,
    canUseTool: config.canUseTool,
    settingSources: config.settingSources ?? ['user', 'project', 'local'],
    includePartialMessages: false,
    stderr: onStderr,
  };
  if (config.model) options.model = config.model;
  if (config.permissionMode) {
    options.permissionMode = config.permissionMode;
    // The SDK requires this alongside bypassPermissions and denies every tool call
    // silently if it is missing; derived here so nothing that asks for bypassPermissions
    // can forget to also ask for this.
    if (config.permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
  }
  if (config.resume) options.resume = config.resume;
  if (config.agents) options.agents = config.agents;
  if (config.env) options.env = config.env;
  if (config.maxTurns !== undefined) options.maxTurns = config.maxTurns;
  if (config.mcpServers) options.mcpServers = config.mcpServers;
  if (config.allowedTools) options.allowedTools = config.allowedTools;
  if (config.tools) options.tools = config.tools;
  if (config.effort) options.effort = config.effort;
  if (config.systemPrompt !== undefined) options.systemPrompt = config.systemPrompt;

  const inspect = config.onToolCall;
  if (inspect) {
    options.hooks = {
      PreToolUse: [
        {
          hooks: [
            async (hookInput, toolUseId) => {
              const info = hookInput as { tool_name?: string; tool_input?: unknown };
              const verdict = await inspect({
                toolName: info.tool_name ?? '',
                input: (info.tool_input ?? {}) as Record<string, unknown>,
                toolUseId: toolUseId ?? '',
              });
              const specific: Record<string, unknown> = { hookEventName: 'PreToolUse' };
              if (verdict.decision) specific['permissionDecision'] = verdict.decision;
              if (verdict.reason) specific['permissionDecisionReason'] = verdict.reason;
              if (verdict.updatedInput) specific['updatedInput'] = verdict.updatedInput;
              if (verdict.additionalContext) specific['additionalContext'] = verdict.additionalContext;
              return {
                continue: verdict.decision !== 'deny',
                hookSpecificOutput: specific,
              } as never;
            },
          ],
        },
      ],
    };
  }
  return options;
}

export class Engine {
  private readonly input = new PushStream<SDKUserMessage>();
  private readonly listeners = new Set<EngineListener>();
  private handle: Query | null = null;
  private pump: Promise<void> | null = null;

  private sessionId: string | null = null;
  private lastServingModel: string | null = null;
  private readonly queryFn: QueryFn;

  /**
   * `queryFn` defaults to the SDK's own `query`. A specimen passes a fake generator here
   * instead, so the whole engine can be driven end to end without a model call.
   */
  constructor(queryFn: QueryFn = query) {
    this.queryFn = queryFn;
  }

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
    const options = buildOptions(config, (data) => this.emit({ type: 'stderr', text: data }));
    this.handle = this.queryFn({ prompt: this.input, options });
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
        const usage = message.message.usage;
        if (usage) {
          this.emit({
            type: 'usage',
            model: model ?? '',
            input: usage.input_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheCreation: typeof usage.cache_creation_input_tokens === 'number'
              ? usage.cache_creation_input_tokens
              : 0,
            output: usage.output_tokens ?? 0,
            parentToolUseId: (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null,
          });
        }
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
        const rawModelUsage = (message as {
          modelUsage?: Record<string, {
            inputTokens?: number; cacheReadInputTokens?: number;
            cacheCreationInputTokens?: number; outputTokens?: number; costUSD?: number;
          }>;
        }).modelUsage;
        if (rawModelUsage && Object.keys(rawModelUsage).length > 0) {
          const modelUsage: Record<string, {
            input: number; cacheRead: number; cacheCreation: number; output: number; costUsd: number;
          }> = {};
          for (const [modelId, usage] of Object.entries(rawModelUsage)) {
            modelUsage[modelId] = {
              input: usage.inputTokens ?? 0,
              cacheRead: usage.cacheReadInputTokens ?? 0,
              cacheCreation: usage.cacheCreationInputTokens ?? 0,
              output: usage.outputTokens ?? 0,
              costUsd: usage.costUSD ?? 0,
            };
          }
          // Emitted before turn-complete, on purpose: sdkengine.ts's segment listener
          // unregisters itself on turn-complete, so this has to land while it is still
          // attached.
          this.emit({ type: 'result-usage', modelUsage });
        }
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

/** What a worker hands back through each of its five tools. */
export interface ForgeToolHandlers {
  onDone: (input: { evidence: string }) => void | Promise<void>;
  onHandoff: (input: { packet: string }) => void | Promise<void>;
  onAsk: (input: {
    question: string;
    options?: string[];
    recommended?: number;
    kind?: 'question' | 'blocker';
  }) => void | Promise<void>;
  onGotcha: (input: {
    what: string;
    where: string;
    error: string;
    prevention: string;
  }) => void | Promise<void>;
  onReport: (input: {
    outcome: string;
    done: string;
    leftOff: string;
    issues?: string;
    blockers?: string;
    unverified?: string;
    cost?: string;
  }) => void | Promise<void>;
}

const ACK = { content: [{ type: 'text' as const, text: 'recorded' }] };

/**
 * The one definition of what a `forge_ask` call must carry, defined here (not in
 * `contracts.ts`) so the schema's own module never has to import back into `contracts.ts`
 * on top of the existing `contracts.ts` -> `engine.ts` edge for `buildForgeMcpServer`.
 * `contracts.ts` imports this export and re-exports it, rather than the reverse, because a
 * second `engine.ts` -> `contracts.ts` edge on top of that existing cycle is exactly what
 * broke `registeredToolNames()` at load time under vitest's SSR transform (W1's own
 * circular-import bug): a live binding referenced before the exporting module finished
 * initializing throws `ReferenceError: Cannot access '...' before initialization`.
 */
export const ForgeAskInputSchema = z.object({
  question: z.string().min(
    1, 'forge_ask requires a non-empty question: a worker must name what it needs answered',
  ),
  options: z.array(z.string()).optional(),
  recommended: z.number().int().optional(),
  kind: z.enum(['question', 'blocker']).optional(),
});

/**
 * The forge tool server: `forge_done`, `forge_handoff`, `forge_ask`, `forge_gotcha`,
 * `forge_report`, the only channel a worker has back to the supervisor.
 *
 * A worker cannot block on a terminal prompt, so `forge_ask` is a tool rather than a
 * question: it writes to the inbox and returns immediately, and the run parks on the
 * `canUseTool` deny that follows it, not on this call.
 */
export function buildForgeMcpServer(handlers: ForgeToolHandlers): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'forge',
    tools: [
      tool('forge_done', 'Mark this run done, with the evidence that proves it.',
        { evidence: z.string() },
        async (args) => { await handlers.onDone(args); return ACK; }),
      tool('forge_handoff', 'Write the handoff packet for the successor session.',
        { packet: z.string() },
        async (args) => { await handlers.onHandoff(args); return ACK; }),
      tool('forge_ask', 'Ask a question that parks this run for a person to answer.',
        ForgeAskInputSchema.shape,
        async (args) => { await handlers.onAsk(args); return ACK; }),
      tool('forge_gotcha', 'File a trap the moment it is hit, and keep working.',
        {
          what: z.string(),
          where: z.string(),
          error: z.string(),
          prevention: z.string(),
        },
        async (args) => { await handlers.onGotcha(args); return ACK; }),
      tool('forge_report', 'File the run report at the end of the goal.',
        {
          outcome: z.string(),
          done: z.string(),
          leftOff: z.string(),
          issues: z.string().optional(),
          blockers: z.string().optional(),
          unverified: z.string().optional(),
          cost: z.string().optional(),
        },
        async (args) => { await handlers.onReport(args); return ACK; }),
    ],
  });
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

/**
 * The real engine behind the worker loop.
 *
 * `worker.ts` takes an engine rather than reaching for the SDK itself, so every specimen
 * runs against a fake stream and the suite spends nothing. This is the other
 * implementation: the one that actually opens a session.
 *
 * The options below are the ones that have cost a session today. A worker opened with an
 * inherited config directory writes into the store the interactive session is using, and
 * a login in either place changes what the other authenticates as. A worker that keeps
 * the nine inherited names saves no transcript, so nothing can read its context or its
 * cost afterwards. Neither looks like a failure from outside, which is why they are
 * asserted rather than trusted.
 *
 * The context a turn carried is `input + cache_read + cache_creation`. Reading
 * `input_tokens` alone reports single digits on a half-million-token turn, and that is
 * exactly how a session reached 543,000 tokens with nothing noticing.
 */
import { Engine, buildForgeMcpServer, type EngineConfig, type ForgeToolHandlers, type PreToolVerdict, type QueryFn } from '../adapter/engine.js';
import { Gotchas } from './gotcha.js';
import { Inbox } from './inbox.js';
import { Journal } from './journal.js';
import { fleetConfigDir } from './paths.js';
import { injectMessages, RunInbox } from './runinbox.js';
import { workerEnv, type EngineLike, type FakeTurn, type SessionRequest, type SessionResult } from './worker.js';

export interface WorkerRequest {
  model: string;
  prompt: string;
  cwd: string;
  maxTurns: number;
  env: NodeJS.ProcessEnv;
  resume?: string;
}

export interface McpServerSpec {
  tools: string[];
}

export interface WorkerOptions {
  model: string;
  prompt: string;
  cwd: string;
  maxTurns: number;
  permissionMode: 'bypassPermissions';
  settingSources: ('user' | 'project')[];
  env: NodeJS.ProcessEnv;
  mcpServers: Record<string, McpServerSpec>;
  resume?: string;
}

/**
 * The tools a worker uses to talk back to the supervisor.
 *
 * Four, and each exists because the alternative is text parsing: a handoff, a completion
 * claim the supervisor then verifies by running commands, a question that parks the run,
 * and a trap filed the moment it is hit.
 */
export const WORKER_TOOLS = ['forge_handoff', 'forge_done', 'forge_ask', 'forge_gotcha'];

export function buildWorkerOptions(request: WorkerRequest): WorkerOptions {
  const env = workerEnv(request.env);
  // Pinned, never inherited. This is the line that keeps the fleet's login separate from
  // the one Aaron is using interactively.
  env['CLAUDE_CONFIG_DIR'] = fleetConfigDir();

  const options: WorkerOptions = {
    model: request.model,
    prompt: request.prompt,
    cwd: request.cwd,
    maxTurns: request.maxTurns,
    permissionMode: 'bypassPermissions',
    // user and project, never local: local settings belong to one machine and a worker
    // that picked them up would behave differently depending on where it ran.
    settingSources: ['user', 'project'],
    env,
    mcpServers: { forge: { tools: [...WORKER_TOOLS] } },
  };
  if (request.resume) options.resume = request.resume;
  return options;
}

export interface RawUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

/**
 * What a turn re-read, which is what it paid for.
 *
 * Output is excluded on purpose: it is written once and is not carried into the next
 * turn, so counting it here would inflate the number the ceiling is compared against.
 */
export function contextOf(usage: RawUsage | undefined): number {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0);
}


/**
 * The worker's options as the adapter takes them.
 *
 * Kept as its own step so the mapping can be asserted end to end. Building the options
 * correctly and having the adapter drop half of them looks identical from inside
 * `buildWorkerOptions`, and until 2026-09-04 engine.ts passed through none of `env`,
 * `maxTurns`, `mcpServers` or `allowedTools`.
 *
 * `canUseTool` routes questions to the inbox rather than to a terminal nobody is at. The
 * default here denies, because a worker that reaches a permission prompt with no handler
 * would otherwise sit at it forever, which is the failure the inbox exists to replace.
 */
export function toEngineConfig(options: WorkerOptions): EngineConfig {
  const config: EngineConfig = {
    cwd: options.cwd,
    model: options.model,
    permissionMode: options.permissionMode,
    settingSources: options.settingSources,
    env: options.env,
    maxTurns: options.maxTurns,
    mcpServers: options.mcpServers as never,
    canUseTool: async () => ({
      behavior: 'deny',
      message: 'a worker asks through forge_ask, which parks the run for a person',
    }) as never,
  };
  if (options.resume) config.resume = options.resume;
  return config;
}

/** The park key an AskUserQuestion is denied on, and the options it offered. */
function extractAskQuestion(input: Record<string, unknown>): { question: string; options: string[] } {
  const questions = (input['questions']
    ?? []) as Array<{ question?: string; options?: Array<{ label?: string }> }>;
  const first = questions[0];
  return {
    question: first?.question ?? 'a worker is asking a question',
    options: (first?.options ?? []).map((option) => option.label ?? '').filter(Boolean),
  };
}

export interface CanUseToolDeps {
  run: string;
  inbox: Inbox;
  journal: Journal;
}

/**
 * Denies every tool that reaches it, and journals why.
 *
 * `canUseTool` is the door of last resort: whatever `permissionMode: bypassPermissions`
 * and every allowed-tools rule let through still lands here if nothing else answered it,
 * and a headless run has nobody at the terminal to answer a prompt. `AskUserQuestion` gets
 * a named park key in the inbox on top of the deny, because a worker that hits it is
 * asking something a person has to decide, not something the run can route around.
 */
export function buildCanUseTool(deps: CanUseToolDeps) {
  return async (toolName: string, input: Record<string, unknown>) => {
    if (toolName === 'AskUserQuestion') {
      const asked = extractAskQuestion(input);
      const entry = deps.inbox.raise({
        run: deps.run, question: asked.question, options: asked.options, kind: 'question',
      });
      deps.journal.append({
        event: 'permission.denied', run: deps.run, actor: 'runner', tool: toolName,
        reason: `parking on ${entry.key}`,
      });
      return {
        behavior: 'deny' as const,
        message: `this run is parking on ${entry.key}: ${asked.question}`,
      };
    }
    deps.journal.append({ event: 'permission.denied', run: deps.run, actor: 'runner', tool: toolName });
    return {
      behavior: 'deny' as const,
      message: 'a worker asks through forge_ask, which parks the run for a person',
    };
  };
}

export interface InboxHookDeps {
  run: string;
  journal: Journal;
}

/**
 * The in-process delivery path: a queued message rides out as `additionalContext` on the
 * very next tool call.
 */
export function buildInboxHook(deps: InboxHookDeps) {
  return async (call: { toolName: string; input: Record<string, unknown>; toolUseId: string }):
    Promise<PreToolVerdict> => {
    const delivered = await injectMessages(deps.run, call.input);
    const additionalContext = delivered?.hookSpecificOutput?.additionalContext;
    if (additionalContext) {
      deps.journal.append({ event: 'inbox.delivered', run: deps.run, actor: 'runner', via: 'hook' });
    }
    return { decision: undefined, ...(additionalContext ? { additionalContext } : {}) };
  };
}

/** What is waiting for a run, rendered as the text a stream-delivery push should carry. */
export function pendingInboxText(run: string): { text: string; ids: string[] } | undefined {
  const inbox = new RunInbox(run);
  const waiting = inbox.unread();
  if (!waiting.length) return undefined;
  const body = waiting
    .map((message) => `[${new Date(message.at).toISOString()} from ${message.from}]\n${message.text}`)
    .join('\n\n');
  return {
    text: 'MESSAGE FOR THIS RUN. Read it before continuing; it may change what you do next.\n\n'
      + body,
    ids: waiting.map((message) => message.id),
  };
}

export interface SdkEngineDeps {
  journalPath: string;
  inboxDir: string;
  gotchasDir: string;
  /**
   * `'hook'` (the default) delivers a queued message through the PreToolUse
   * `additionalContext` channel. `'stream'` is the fallback: it pushes the same message
   * through the engine's streaming input as a user message, for the case where the CLI
   * drops in-process `additionalContext` the way it dropped the subprocess hook's.
   */
  deliverVia?: 'hook' | 'stream';
  queryFn?: QueryFn;
}

/**
 * The production `EngineLike`: the worker loop's other half, the one that actually opens
 * a session.
 *
 * `run()` resolves when the session's first `result` arrives, having collected one
 * `FakeTurn`-shaped record per assistant message along the way, each carrying the usage
 * that message reported. `send()` pushes another prompt into the same session and
 * resolves on the next `result`, which is how the handoff request and any answered
 * question travel back in without starting a second session.
 */
export class SdkEngine implements EngineLike {
  readonly started: SessionRequest[] = [];

  private readonly deliverVia: 'hook' | 'stream';

  constructor(private readonly deps: SdkEngineDeps) {
    this.deliverVia = deps.deliverVia ?? 'hook';
  }

  async run(request: SessionRequest): Promise<SessionResult> {
    this.started.push(request);

    const workerOptions = buildWorkerOptions({
      model: request.model,
      prompt: request.prompt,
      cwd: request.cwd,
      maxTurns: request.maxTurns,
      env: request.env,
      ...(request.resume ? { resume: request.resume } : {}),
    });

    const journal = new Journal(this.deps.journalPath);
    const inbox = new Inbox(this.deps.inboxDir);
    const gotchas = new Gotchas(this.deps.gotchasDir, this.deps.journalPath);
    const runInbox = new RunInbox(request.run);

    const handlers: ForgeToolHandlers = {
      onDone: (input) => {
        journal.append({ event: 'forge.done', run: request.run, actor: 'worker', evidence: input.evidence });
      },
      onHandoff: (input) => {
        journal.append({ event: 'forge.handoff', run: request.run, actor: 'worker', packet: input.packet });
      },
      onAsk: (input) => {
        inbox.raise({
          run: request.run, question: input.question, options: input.options, kind: input.kind,
        });
        journal.append({
          event: 'forge.ask', run: request.run, actor: 'worker', question: input.question,
        });
      },
      onGotcha: (input) => {
        gotchas.file({ run: request.run, ...input });
      },
      onReport: (input) => {
        journal.append({ event: 'forge.report', run: request.run, actor: 'worker', ...input });
      },
    };

    const engineConfig: EngineConfig = {
      cwd: workerOptions.cwd,
      model: workerOptions.model,
      permissionMode: workerOptions.permissionMode,
      settingSources: workerOptions.settingSources,
      env: workerOptions.env,
      maxTurns: workerOptions.maxTurns,
      mcpServers: { forge: buildForgeMcpServer(handlers) },
      canUseTool: buildCanUseTool({ run: request.run, inbox, journal }) as never,
      ...(this.deliverVia === 'hook'
        ? { onToolCall: buildInboxHook({ run: request.run, journal }) }
        : {}),
      ...(workerOptions.resume ? { resume: workerOptions.resume } : {}),
    };

    const engine = new Engine(this.deps.queryFn);
    engine.start(engineConfig);

    // Context is charged again on every turn, so what the ceiling compares against is
    // the running total across the whole run, not any one message's own usage: two
    // messages of 40,000 and 25,000 together describe a session that has read 65,000
    // tokens, and the second alone would look safely under a 60,000 ceiling.
    let runningContext = 0;

    const runSegment = (promptText: string): Promise<FakeTurn[]> => new Promise((resolve, reject) => {
      const turns: FakeTurn[] = [];
      let pending: FakeTurn | null = null;
      const flush = () => {
        if (pending) {
          turns.push(pending);
          pending = null;
        }
      };
      const off = engine.onEvent((event) => {
        switch (event.type) {
          case 'usage':
            flush();
            runningContext += event.input + event.cacheRead + event.cacheCreation;
            pending = {
              text: '',
              context: runningContext,
              usage: {
                input: event.input, cacheRead: event.cacheRead,
                cacheCreation: event.cacheCreation, output: event.output,
              },
            };
            break;
          case 'assistant-text':
            if (pending) pending.text += event.text;
            break;
          case 'tool-use':
            if (pending && event.name.endsWith('forge_done')) pending.done = true;
            break;
          case 'turn-complete':
            flush();
            off();
            resolve(turns);
            break;
          case 'engine-error':
            if (event.fatal) {
              off();
              reject(new Error(event.message));
            }
            break;
          default:
            break;
        }
      });

      let text = promptText;
      if (this.deliverVia === 'stream') {
        const pendingMessage = pendingInboxText(request.run);
        if (pendingMessage) {
          text = `${pendingMessage.text}\n\n${promptText}`;
          runInbox.markRead(pendingMessage.ids);
          journal.append({ event: 'inbox.delivered', run: request.run, actor: 'runner', via: 'stream' });
        }
      }
      engine.send(text);
    });

    const turns = await runSegment(request.prompt);
    const sessionId = engine.currentSessionId ?? request.run;

    return {
      sessionId,
      turns,
      send: (prompt: string) => runSegment(prompt),
    };
  }
}

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

/**
 * The two tool-call names the run loop itself has to recognise, qualified the way the SDK
 * presents an MCP server's tools to the model. Matched exactly rather than by suffix: a
 * different server whose author happened to register a tool ending in `forge_done` must
 * never be able to end a worker's session chain early.
 */
const FORGE_DONE_TOOL = 'mcp__forge__forge_done';
const FORGE_HANDOFF_TOOL = 'mcp__forge__forge_handoff';

export function buildWorkerOptions(
  request: WorkerRequest,
  existsConfigDir?: (path: string) => boolean,
): WorkerOptions {
  const env = workerEnv(request.env);
  // Pinned, never inherited. This is the line that keeps the fleet's login separate from
  // the one Aaron is using interactively.
  env['CLAUDE_CONFIG_DIR'] = fleetConfigDir(existsConfigDir);

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
  /**
   * The park state: run name to the ask key it is parked on. Shared with the PreToolUse
   * hook (`buildPreToolUseHook`) built for the same run, so a deny here is what makes
   * every later tool call on this run deny too, until `SdkEngine.answer` clears it.
   */
  parked: Map<string, string>;
}

/**
 * Denies every tool that reaches it, and journals why.
 *
 * `canUseTool` is the door of last resort: whatever `permissionMode: bypassPermissions`
 * and every allowed-tools rule let through still lands here if nothing else answered it,
 * and a headless run has nobody at the terminal to answer a prompt. `AskUserQuestion` gets
 * a named park key in the inbox on top of the deny, because a worker that hits it is
 * asking something a person has to decide, not something the run can route around. It also
 * sets the run's entry in `parked`, which is what turns "this one call was denied" into
 * "nothing on this run moves again until a person answers."
 */
export function buildCanUseTool(deps: CanUseToolDeps) {
  return async (toolName: string, input: Record<string, unknown>) => {
    if (toolName === 'AskUserQuestion') {
      const asked = extractAskQuestion(input);
      const entry = deps.inbox.raise({
        run: deps.run, question: asked.question, options: asked.options, kind: 'question',
      });
      deps.parked.set(deps.run, entry.key);
      deps.journal.append({
        event: 'permission.denied', run: deps.run, actor: 'runner', tool: toolName,
        reason: `parking on ${entry.key}`,
      });
      deps.journal.append({
        event: 'run.parked', run: deps.run, actor: 'runner', key: entry.key,
        reason: `parking on ${entry.key}: ${asked.question}`,
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

export interface PreToolUseHookDeps {
  run: string;
  journal: Journal;
  /** Shared with `buildCanUseTool`: run name to the ask key it is parked on. */
  parked: Map<string, string>;
  deliverVia: 'hook' | 'stream';
}

/**
 * The PreToolUse hook a live run's engine is opened with. It sees every tool call, not
 * only the ones a permission rule would otherwise route to `canUseTool`, which is what
 * makes it the place a park actually holds: a deny here happens before the tool runs, on
 * every call, for as long as `parked` names this run.
 *
 * The park check runs first and short-circuits: a parked run gets no inbox delivery
 * either, because there is nothing left for it to act on until the park clears.
 */
export function buildPreToolUseHook(deps: PreToolUseHookDeps) {
  const inboxHook = deps.deliverVia === 'hook' ? buildInboxHook({ run: deps.run, journal: deps.journal }) : undefined;
  return async (call: { toolName: string; input: Record<string, unknown>; toolUseId: string }):
    Promise<PreToolVerdict> => {
    const key = deps.parked.get(deps.run);
    if (key) {
      deps.journal.append({
        event: 'permission.denied', run: deps.run, actor: 'runner', tool: call.toolName,
        reason: `parked on ${key}`,
      });
      return {
        decision: 'deny',
        reason: `parked on ${key}: this run takes no further tool call until that question is answered`,
      };
    }
    if (inboxHook) return inboxHook(call);
    return { decision: undefined };
  };
}

export interface StreamPushEngine {
  send(text: string): void;
}

/**
 * The stream fallback's whole delivery step: fold anything waiting in the run's inbox
 * into the prompt, push it, and mark those messages read only once the push does not
 * throw.
 *
 * A push that throws (the CLI drops the stream, the process underneath is gone) must not
 * also lose the message it was carrying: marking read before the push, as this used to,
 * meant a failed push and a silently dropped message looked identical to a delivered one.
 */
export function deliverViaStream(
  engine: StreamPushEngine, run: string, promptText: string, journal: Journal,
): string {
  const pendingMessage = pendingInboxText(run);
  const text = pendingMessage ? `${pendingMessage.text}\n\n${promptText}` : promptText;
  engine.send(text);
  if (pendingMessage) {
    new RunInbox(run).markRead(pendingMessage.ids);
    journal.append({ event: 'inbox.delivered', run, actor: 'runner', via: 'stream' });
  }
  return text;
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
  /**
   * Run name to the ask key it is parked on. Defaults to a fresh map: production has one
   * `SdkEngine` per `forge run` process, so nothing outside a specimen needs to share it.
   */
  parked?: Map<string, string>;
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

  /**
   * One handle for the life of this engine, not one per `run()` call.
   *
   * A chain calls `run()` once per successor session; a fresh `Journal` on each call
   * would leave every earlier one open, and `journal.ts`'s own contract is that a leaked
   * handle keeps the file locked against a reader in the same process on Windows.
   */
  private readonly journal: Journal;

  /** Run name to the ask key it is parked on. Shared by `canUseTool` and the PreToolUse hook. */
  private readonly parked: Map<string, string>;

  /**
   * The live `Engine` for each run this instance has started, kept for the life of this
   * `SdkEngine` so `answer()` can push into a session that is still open. Cleared by
   * `close()`, which is called once per whole chain, matching the journal handle above.
   */
  private readonly liveEngines = new Map<string, Engine>();

  constructor(private readonly deps: SdkEngineDeps) {
    this.deliverVia = deps.deliverVia ?? 'hook';
    this.journal = new Journal(deps.journalPath);
    this.parked = deps.parked ?? new Map();
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

    const journal = this.journal;
    const inbox = new Inbox(this.deps.inboxDir);
    const gotchas = new Gotchas(this.deps.gotchasDir, this.deps.journalPath);

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
      canUseTool: buildCanUseTool({ run: request.run, inbox, journal, parked: this.parked }) as never,
      onToolCall: buildPreToolUseHook({
        run: request.run, journal, parked: this.parked, deliverVia: this.deliverVia,
      }),
      ...(workerOptions.resume ? { resume: workerOptions.resume } : {}),
    };

    const engine = new Engine(this.deps.queryFn);
    engine.start(engineConfig);
    this.liveEngines.set(request.run, engine);

    // Each assistant message's usage already carries the whole context of that turn --
    // uncached input plus cache read plus cache creation is the entire prompt that turn
    // re-read, not an increment on top of the last one. So the ceiling (and the context
    // this loop journals) reads the latest message's own usage, never a running sum:
    // summing two 140,000-token requests would read 280,000 and hand off under a
    // 150,000 ceiling for a session whose real context is 140,000. Cost is tracked
    // separately, per turn, from each turn's own `usage` (see journal.ts's `costOf`),
    // so it never needs a cumulative context total either.
    let latestContext = 0;
    // Named per call id rather than per segment: a tool's result event carries only the
    // id it answers, not the tool's name, so the name has to be remembered from the
    // matching tool-use to journal a tool.end a reader can act on.
    const toolNameById = new Map<string, string>();

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
            latestContext = event.input + event.cacheRead + event.cacheCreation;
            pending = {
              text: '',
              context: latestContext,
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
            toolNameById.set(event.id, event.name);
            journal.append({ event: 'tool.start', run: request.run, actor: 'worker', tool: event.name });
            // The SDK's usage field is required on every real assistant message, so
            // `pending` should already exist; a defensive turn is opened here rather than
            // dropped, so a forge_done or forge_handoff call can never go unrecognised on
            // the chance a message arrives with no preceding usage event.
            if (!pending) {
              pending = { text: '', context: latestContext };
            }
            if (event.name === FORGE_HANDOFF_TOOL) {
              // The successor reads this turn's text as the packet (worker.ts's
              // requestHandoff joins every turn's text after a send()). Without this the
              // tool call still fires and journals, but the packet itself never reaches
              // the chain that is supposed to carry it forward.
              const packet = (event.input as { packet?: unknown }).packet;
              if (typeof packet === 'string') pending.text += packet;
            }
            break;
          case 'tool-result':
            journal.append({
              event: 'tool.end', run: request.run, actor: 'worker',
              tool: toolNameById.get(event.id) ?? '', isError: event.isError,
            });
            // `done` is set on the result, not the call: a forge_done whose result comes
            // back an error (a malformed evidence argument, the handler throwing) must
            // not read as a finished run just because the model tried to call it.
            if (toolNameById.get(event.id) === FORGE_DONE_TOOL && !event.isError && pending) {
              pending.done = true;
            }
            break;
          case 'turn-complete':
            flush();
            off();
            resolve(turns);
            break;
          case 'engine-error':
            // Not fatal to the segment (a `result` message still follows and resolves it),
            // but a turn that errored partway through must not read identically to one
            // that finished cleanly, or a billing or rate-limit failure looks like progress.
            journal.append({
              event: 'engine.error', run: request.run, actor: 'worker', message: event.message,
              fatal: event.fatal,
            });
            if (event.fatal) {
              off();
              reject(new Error(event.message));
            }
            break;
          default:
            break;
        }
      });

      if (this.deliverVia === 'stream') {
        deliverViaStream(engine, request.run, promptText, journal);
      } else {
        engine.send(promptText);
      }
    });

    const turns = await runSegment(request.prompt);
    const sessionId = engine.currentSessionId ?? request.run;

    return {
      sessionId,
      turns,
      send: (prompt: string) => runSegment(prompt),
    };
  }

  /**
   * `forge answer KEY TEXT`, for a run this instance itself has a live session for.
   *
   * Only delivers when both hold: the run is actually parked on this exact key (answering
   * a stale or wrong key does nothing, on purpose -- a park exists so a decision made for
   * a different question can never be mistaken for this one), and this process still holds
   * that run's live engine. The second condition fails across a process boundary (a
   * separate `forge answer` invocation against a run some other `forge run` process owns),
   * which is what `RunInbox`-based delivery and session-id resume exist to cover instead.
   */
  async answer(run: string, key: string, text: string): Promise<{ delivered: boolean }> {
    if (this.parked.get(run) !== key) return { delivered: false };
    this.parked.delete(run);
    this.journal.append({ event: 'run.resumed', run, actor: 'console', key });
    const engine = this.liveEngines.get(run);
    if (!engine) return { delivered: false };
    await new Promise<void>((resolve) => {
      const off = engine.onEvent((event) => {
        if (event.type === 'turn-complete') {
          off();
          resolve();
        }
      });
      engine.send(text);
    });
    return { delivered: true };
  }

  /** Releases the journal handle. Call once the whole chain, not one session, is done. */
  close(): void {
    this.journal.close();
    this.liveEngines.clear();
    this.parked.clear();
  }
}

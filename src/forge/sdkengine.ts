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
import { FORGE_TOOL_NAMES, redact, type Incarnation } from './contracts.js';
import {
  classifyDriftRead, credentialBlocker, readMergeableDetailed,
  resolveMergeableRead, type DriftClock, type Mergeable, type MergeableRead,
} from './drift.js';
import { classifyCommand } from './command-class.js';
import { toolTarget } from './tool-target.js';
import { run as execRun } from './exec.js';
import { Gotchas } from './gotcha.js';
import { redactFields } from './redact.js';
import { askKey, Inbox, type InboxEntry } from './inbox.js';
import { Journal } from './journal.js';
import { fleetConfigDir } from './paths.js';
import { readParkRecord } from './parkrecord.js';
import {
  authorshipRule, gitflowRule, humanizerRule, sycophancyRule, vaguenessRule,
  type ProposedAction, type Rule, type RuleVerdict,
} from './rules/index.js';
import { injectMessages, RunInbox } from './runinbox.js';
import {
  HANDOFF_REQUEST, STOP_HANDOFF_REQUEST, workerEnv, type EngineLike, type FakeTurn, type SessionRequest,
  type SessionResult,
} from './worker.js';

export interface WorkerRequest {
  model: string;
  prompt: string;
  cwd: string;
  /** Omitted for an implement-class run (B.3.8): no maxTurns reaches the SDK at all. */
  maxTurns?: number;
  env: NodeJS.ProcessEnv;
  resume?: string;
  /** The class's own effort, from model-policy.json. */
  effort?: string;
  /** P4.8: the account this run was assigned to (`accountFor`, `governor.ts`), pinned
   *  here instead of the fleet's single hardcoded directory. Undefined keeps this
   *  request pinning `fleetConfigDir()` exactly as it always has. */
  configDir?: string;
}

export interface McpServerSpec {
  tools: string[];
}

export interface WorkerOptions {
  model: string;
  prompt: string;
  cwd: string;
  maxTurns?: number;
  permissionMode: 'bypassPermissions';
  settingSources: ('user' | 'project')[];
  env: NodeJS.ProcessEnv;
  mcpServers: Record<string, McpServerSpec>;
  resume?: string;
  effort?: string;
}

/**
 * The tools a worker uses to talk back to the supervisor.
 *
 * Sourced from `contracts.ts`'s `FORGE_TOOL_NAMES`, which is itself read off a live
 * `buildForgeMcpServer` instance (see that file), rather than typed out here a second
 * time: a handoff, a completion claim the supervisor then verifies by running commands,
 * a question that parks the run, a trap filed the moment it is hit, and the end-of-goal
 * report. A hand-typed copy of this list drifted to four names (missing `forge_report`)
 * while nothing in production read it at all: `SdkEngine.run()` always registered the
 * real handlers straight from `buildForgeMcpServer`, and `toEngineConfig` (which does
 * read this list, for its own name-only `mcpServers` field) never ran in production
 * either. `toEngineConfig` is now called from `SdkEngine.run()` for the rest of its
 * mapping (env, maxTurns, effort, resume), which is what makes it worth this list being
 * unable to drift again rather than merely re-typed correctly once.
 */
export const WORKER_TOOLS: readonly string[] = FORGE_TOOL_NAMES;

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
  // the one Aaron is using interactively. `request.configDir`, when a caller assigned
  // this run an account (P4.8's `accountFor`), pins to that account's own directory
  // instead of falling back to the single hardcoded fleet directory.
  env['CLAUDE_CONFIG_DIR'] = request.configDir ?? fleetConfigDir(existsConfigDir);

  const options: WorkerOptions = {
    model: request.model,
    prompt: request.prompt,
    cwd: request.cwd,
    ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
    permissionMode: 'bypassPermissions',
    // user and project, never local: local settings belong to one machine and a worker
    // that picked them up would behave differently depending on where it ran.
    settingSources: ['user', 'project'],
    env,
    mcpServers: { forge: { tools: [...WORKER_TOOLS] } },
  };
  if (request.resume) options.resume = request.resume;
  if (request.effort) options.effort = request.effort;
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
  if (options.effort) config.effort = options.effort as never;
  return config;
}

/**
 * Whether one of a shell command's top-level segments actually invokes `program subcommand`
 * as its first two words, rather than merely mentioning that text.
 *
 * A bare `/\bgit\s+commit\b/` regex also fires on `git log --grep "git commit"` or an echoed
 * string, which is not a commit: splitting on the shell's own separators first and checking
 * the first two words of each segment is what tells "ran it" apart from "said it".
 */
function invokesCommand(command: string, program: string, ...subcommand: string[]): boolean {
  return command
    .split(/&&|\|\||[;|\n]/)
    .some((segment) => {
      const words = segment.trim().split(/\s+/);
      return words[0] === program && subcommand.every((word, index) => words[index + 1] === word);
    });
}

/** The park key an AskUserQuestion is denied on, and the options it offered. */
function extractAskQuestion(input: Record<string, unknown>): { question: string; options: string[] } {
  const questions = (input['questions']
    ?? []) as Array<{ question?: string; options?: Array<{ label?: string }> }>;
  if (questions.length <= 1) {
    const first = questions[0];
    return {
      question: first?.question ?? 'a worker is asking a question',
      options: (first?.options ?? []).map((option) => option.label ?? '').filter(Boolean),
    };
  }
  // A multi-question AskUserQuestion parks on all of them, named by count, rather than
  // silently dropping every question after the first.
  const combined = questions
    .map((question, index) => `Q${index + 1}: ${question.question ?? '(no question text)'}`)
    .join('\n');
  return {
    question: `${questions.length} questions asked together:\n${combined}`,
    options: questions.flatMap((question) => (question.options ?? []).map((option) => option.label ?? ''))
      .filter(Boolean),
  };
}

export interface CanUseToolDeps {
  run: string;
  /** The stable goal id, part of the ask key alongside run and action target: B.3.7. */
  goal: string;
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
 * Records a park against a run: sets `parked`, and journals `run.parked` with the key.
 *
 * The one place both walls a run can hit go through: `AskUserQuestion`, denied at
 * `canUseTool`, and `forge_ask`, which calls it from its own tool handler (F3). Before F3,
 * `forge_ask` raised the inbox entry and journaled `forge.ask` but never called this, so a
 * run that asked through the tool rather than through `AskUserQuestion` parked nothing: the
 * next tool call went straight through, and no other process had a park key to answer.
 */
export function parkRun(
  deps: { parked: Map<string, string>; journal: Journal }, run: string, entry: InboxEntry,
): void {
  deps.parked.set(run, entry.key);
  deps.journal.append({
    event: 'run.parked', run, actor: 'runner', key: entry.key,
    reason: `parking on ${entry.key}: ${entry.question}`,
  });
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
        run: deps.run, goal: deps.goal, actionTarget: 'AskUserQuestion',
        question: asked.question, options: asked.options, kind: 'question',
      });
      deps.journal.append({
        event: 'permission.denied', run: deps.run, actor: 'runner', tool: toolName,
        reason: `parking on ${entry.key}`,
      });
      parkRun(deps, deps.run, entry);
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
  /** This segment's own name, for the journal rows this writes. */
  run: string;
  /** The goal's stable id, for the inbox itself: B.3.7. A message sent to the goal id
   *  must reach whichever segment is live, not only the one whose exact name it was sent
   *  under, which stops existing the moment a handoff renames the run. */
  goal: string;
  journal: Journal;
  /** Called with the delivered message ids and their raw text, when something was
   *  delivered, so the caller can watch for it to be acknowledged: B.3.7. */
  onDelivered?: (ids: string[], text: string) => void;
}

/**
 * The in-process delivery path: a queued message rides out as `additionalContext` on the
 * very next tool call.
 */
export function buildInboxHook(deps: InboxHookDeps) {
  return async (call: { toolName: string; input: Record<string, unknown>; toolUseId: string }):
    Promise<PreToolVerdict> => {
    const delivered = await injectMessages(deps.goal, call.input);
    const additionalContext = delivered?.hookSpecificOutput?.additionalContext;
    if (additionalContext) {
      deps.journal.append({ event: 'inbox.delivered', run: deps.run, actor: 'runner', via: 'hook' });
      if (delivered?.messageIds?.length) deps.onDelivered?.(delivered.messageIds, delivered.rawText ?? '');
    }
    return { decision: undefined, ...(additionalContext ? { additionalContext } : {}) };
  };
}

export interface PreToolUseHookDeps {
  run: string;
  /** The goal's stable id, for the inbox: B.3.7. */
  goal: string;
  journal: Journal;
  /** Shared with `buildCanUseTool`: run name to the ask key it is parked on. */
  parked: Map<string, string>;
  /**
   * The same `Inbox` `canUseTool` and `forge_ask` write park entries into. Read here on
   * every parked call (F2) so an answer written by a separate `forge answer` process is
   * seen the moment it lands, not only by `SdkEngine.answer()`, which only ever reaches a
   * session this same process still holds open.
   */
  inbox: Inbox;
  /**
   * True once this run's latest usage has reached its class ceiling. Checked after park,
   * before inbox delivery, so a session past its ceiling gets no further tool call: only
   * the handoff prompt, riding along as `additionalContext` on the deny itself, so the
   * model does not need a whole extra turn just to be told to write the packet.
   */
  ceilingHit?: () => boolean;
  /**
   * P4.7/I8: true once `forge stop --all` has engaged the kill switch. Checked right
   * after the park and before the context ceiling, since an operator-initiated stop is a
   * harder wall than a ceiling the run itself is approaching. Undefined means no caller
   * wired it -- a real `forge run` always does; a specimen with no stopping concern needs
   * no fake.
   */
  killSwitchHit?: () => boolean;
  deliverVia: 'hook' | 'stream';
  onDelivered?: (ids: string[], text: string) => void;
  /**
   * P4.7/I4: the branch this run's checkout is on, and whether that repo is controlled
   * code, so the ported `gitflow` rule (which is a pure function -- decision 1 of the
   * Council brief -- and takes both rather than shelling out to `git` itself) has what
   * it needs. Neither is discovered here: nothing in `sdkengine.ts` reads a repo registry
   * or runs `git`, so a caller that supplies neither gets `gitflow`'s permissive default
   * (every branch reads as safe, every repo as uncontrolled) rather than a guess.
   */
  repoContext?: { branch?: string; controlled?: boolean };
  /** I14: this run's own working directory, so the prose rules can tell an edit inside
   *  the run's repository from one outside it (an internal agent file elsewhere on the
   *  machine, such as a goal brief under `.claude/goals/`). Undefined means no caller
   *  named it -- every edit is judged as if it were inside the run's own repo, the
   *  permissive default this hook already used before this field existed. */
  runCwd?: string;
}

/**
 * The PreToolUse hook a live run's engine is opened with. It sees every tool call, not
 * only the ones a permission rule would otherwise route to `canUseTool`, which is what
 * makes it the place a park, and the context ceiling, actually hold: a deny here happens
 * before the tool runs, on every call, for as long as `parked` names this run or
 * `ceilingHit()` says so.
 *
 * The park check runs first, then the ceiling, and both short-circuit: neither gets inbox
 * delivery either, because there is nothing left for either to act on until it clears.
 *
 * While parked, this reads the shared `Inbox` entry for the key before denying (F2): if it
 * already carries an answer, the park clears here, `run.resumed` is journaled, and the call
 * is allowed with the resume prompt riding along as `additionalContext`, so a model that
 * kept calling tools after the deny can be resumed from a separate `forge answer` process
 * too, not only through `SdkEngine.answer()` on the process that still holds the session.
 */
export function buildPreToolUseHook(deps: PreToolUseHookDeps) {
  const inboxHook = deps.deliverVia === 'hook'
    ? buildInboxHook({
      run: deps.run, goal: deps.goal, journal: deps.journal, onDelivered: deps.onDelivered,
    })
    : undefined;
  return async (call: { toolName: string; input: Record<string, unknown>; toolUseId: string }):
    Promise<PreToolVerdict> => {
    const parkRecord = readParkRecord(deps.run);
    if (parkRecord) {
      deps.journal.append({
        event: 'permission.denied', run: deps.run, actor: 'runner', tool: call.toolName,
        reason: `parked by warden: ${parkRecord.key}`,
      });
      return {
        decision: 'deny',
        reason: `parked by warden: ${parkRecord.reason}`,
      };
    }
    const key = deps.parked.get(deps.run);
    if (key) {
      const entry = deps.inbox.entry(key);
      if (entry?.answer !== undefined) {
        deps.parked.delete(deps.run);
        deps.journal.append({ event: 'run.resumed', run: deps.run, actor: 'console', key });
        return { decision: undefined, additionalContext: deps.inbox.resumePrompt(key) };
      }
      deps.journal.append({
        event: 'permission.denied', run: deps.run, actor: 'runner', tool: call.toolName,
        reason: `parked on ${key}`,
      });
      return {
        decision: 'deny',
        reason: `parked on ${key}: this run takes no further tool call until that question is answered`,
      };
    }
    // Confirmed on a live run 2026-09-06: a worker called Monitor with a plain shell
    // command (no websocket, `persistent: true`, watching `gh pr checks`) and its own
    // `-p` session ended mid-turn, never finishing, never hitting the context ceiling --
    // `worker.ts` read that as `verdict: 'stopped'`. `checkLaunch`'s `WS_MONITOR` regex
    // only ever caught a websocket-sourced Monitor named in the brief text; it said
    // nothing about the worker's own tool calls, and nothing else here stopped a plain
    // polling Monitor from taking the session down the same way. A worker has no console
    // to watch a Monitor's notifications on, so the tool is refused outright rather than
    // narrowed to the one shape that has already been seen killing a session.
    if (call.toolName === 'Monitor') {
      deps.journal.append({
        event: 'permission.denied', run: deps.run, actor: 'runner', tool: call.toolName,
        reason: 'a worker session has no console to watch Monitor notifications on, and a Monitor call has '
          + 'ended a live worker session mid-turn without finishing; poll status yourself with Bash instead',
      });
      return {
        decision: 'deny',
        reason: 'Monitor is refused inside a worker run: it has ended a session mid-turn before, and there is '
          + 'no console here to receive its notifications. Poll with a plain Bash command instead.',
      };
    }
    if (deps.killSwitchHit?.()) {
      deps.journal.append({
        event: 'permission.denied', run: deps.run, actor: 'runner', tool: call.toolName,
        reason: 'the fleet kill switch is engaged',
      });
      return {
        decision: 'deny',
        reason: 'forge stop --all engaged the kill switch: write the handoff packet instead of another tool call',
        additionalContext: STOP_HANDOFF_REQUEST,
      };
    }
    if (deps.ceilingHit?.()) {
      deps.journal.append({
        event: 'permission.denied', run: deps.run, actor: 'runner', tool: call.toolName,
        reason: 'context ceiling reached',
      });
      return {
        decision: 'deny',
        reason: 'context ceiling reached: write the handoff packet instead of another tool call',
        additionalContext: HANDOFF_REQUEST,
      };
    }
    // P4.7/I4 (scoped by P4.7/I10): the Council's rules library, on every Bash and
    // Edit/Write call. A denial here journals `rule.denied` and stops the call the same
    // way a park does; every other tool name (Read, Grep, the forge_* MCP tools) is
    // untouched. `evaluateScoped` never ends the run itself -- it only denies the one
    // tool call, the same as any other rule verdict, leaving the worker free to try
    // something else on its next turn.
    const action = proposedActionFor(call.toolName, call.input, deps.repoContext);
    if (action) {
      const verdict = evaluateScoped(action, deps.runCwd);
      if (!verdict.allow) {
        const sink = action.kind;
        const locator = action.kind === 'edit'
          ? { path: action.path }
          : action.kind === 'bash'
            ? { command: action.command }
            : {};
        deps.journal.append({
          event: 'rule.denied', run: deps.run, actor: 'runner', tool: call.toolName,
          rule: verdict.rule, reason: verdict.reason, sink, ...locator,
        });
        const locatorNote = action.kind === 'edit' ? ` (path: ${action.path})` : '';
        return { decision: 'deny', reason: `${verdict.rule}: ${verdict.reason}${locatorNote}` };
      }
    }
    if (inboxHook) return inboxHook(call);
    return { decision: undefined };
  };
}

/**
 * P4.7/I10: gitflow and authorship keep judging every Bash/Edit action -- their scope is
 * unchanged. Humanizer, sycophancy and vagueness judge prose, never code, so they run
 * only when the call's SHAPE says it produces outward-facing prose: a git commit message,
 * a `gh pr`/`gh issue` create-edit-comment body or title, or a Write/Edit whose path is a
 * doc. `isProseSink` reads the tool name, the command's subcommand, and the file
 * extension only -- never the command's or file's own content -- because guessing prose
 * from content is exactly the failure this item forbids (a `--colors=false` flag or an
 * `i--` decrement inside a source file is not an em dash).
 */
const ALWAYS_ON_RULES: Rule[] = [gitflowRule, authorshipRule];
const PROSE_RULES: Rule[] = [humanizerRule, sycophancyRule, vaguenessRule];

const PROSE_PATH_RE = /\.(md|mdx)$/i;
const DOCS_DIR_RE = /(^|[/\\])docs([/\\]|$)/i;

// I14: a run's `Edit` of its own goal brief, under its `.claude/goals/` directory, was
// denied by the humanizer rule for a `--`, and the model ended its turn over it. That
// file is
// the run's own internal log, never outward-facing prose, and the humanizer skill's own
// exclusion list already says so (`CLAUDE.md`, `.claude/**`, memory and plan files).
// These mirror that list for the one caller (this hook) the skill was never wired into.
const DOT_CLAUDE_SEGMENT_RE = /(^|[/\\])\.claude([/\\]|$)/i;
const CLAUDE_MD_RE = /(^|[/\\])CLAUDE\.md$/i;
const MEMORY_OR_PLAN_FILE_RE = /(^|[/\\])(memory|plan)[^/\\]*\.md$/i;

/** True for a path outside the run's own repository checkout, in addition to the named
 *  internal-agent patterns above -- a rule judging outward-facing prose has no business
 *  with anything that is not this run's own working tree, whatever its extension. */
function isInternalAgentPath(path: string, runCwd?: string): boolean {
  if (DOT_CLAUDE_SEGMENT_RE.test(path) || CLAUDE_MD_RE.test(path) || MEMORY_OR_PLAN_FILE_RE.test(path)) {
    return true;
  }
  if (!runCwd) return false;
  const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
  const normalizedCwd = runCwd.replace(/\\/g, '/').toLowerCase();
  return isAbsolutePathLike(normalizedPath) && !normalizedPath.startsWith(normalizedCwd);
}

function isAbsolutePathLike(path: string): boolean {
  return path.startsWith('/') || /^[a-z]:\//.test(path);
}

function isProseSink(action: ProposedAction, runCwd?: string): boolean {
  if (action.kind === 'edit') {
    if (isInternalAgentPath(action.path, runCwd)) return false;
    return PROSE_PATH_RE.test(action.path) || DOCS_DIR_RE.test(action.path);
  }
  if (action.kind === 'bash') {
    const tokens = action.command.trim().split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, ''));
    if (tokens[0] === 'git') {
      return tokens[1] === 'commit'
        && ['-m', '--message', '-F', '--file'].some((flag) => tokens.includes(flag));
    }
    if (tokens[0] === 'gh') {
      if (tokens[1] === 'pr' || tokens[1] === 'issue') {
        return ['create', 'edit', 'comment'].includes(tokens[2] ?? '');
      }
    }
    return false;
  }
  // 'commit', 'pr' and 'reply' kinds never arise from this hook (only Bash and
  // Edit/Write/NotebookEdit calls do), but they are prose by construction for any other
  // caller of this library, so default to judging them.
  return true;
}

function evaluateScoped(action: ProposedAction, runCwd?: string): RuleVerdict {
  for (const rule of ALWAYS_ON_RULES) {
    const verdict = rule.evaluate(action);
    if (!verdict.allow) return verdict;
  }
  if (isProseSink(action, runCwd)) {
    for (const rule of PROSE_RULES) {
      const verdict = rule.evaluate(action);
      if (!verdict.allow) return verdict;
    }
  }
  return { allow: true };
}

/**
 * A `PreToolUse` call's own toolName/input, translated to the rules library's
 * `ProposedAction` shape. `undefined` for every tool the library has no opinion on
 * (Read, Grep, the `forge_*` MCP tools), so the caller skips `evaluateAction` entirely
 * rather than asking it to judge a shape it was never built to see.
 */
function proposedActionFor(
  toolName: string, input: Record<string, unknown>, repoContext?: { branch?: string; controlled?: boolean },
): ProposedAction | undefined {
  if (toolName === 'Bash') {
    return {
      kind: 'bash', command: String(input['command'] ?? ''), cwd: process.cwd(),
      ...(repoContext?.branch !== undefined ? { branch: repoContext.branch } : {}),
      ...(repoContext?.controlled !== undefined ? { controlled: repoContext.controlled } : {}),
    };
  }
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    const text = String(input['new_string'] ?? input['content'] ?? '');
    return { kind: 'edit', path: String(input['file_path'] ?? input['path'] ?? ''), text };
  }
  return undefined;
}

export interface ForgeHandlerDeps {
  run: string;
  /** The stable goal id, for `forge_ask`'s inbox entry: B.3.7. */
  goal: string;
  inbox: Inbox;
  journal: Journal;
  /** Shared with `buildCanUseTool` and the PreToolUse hook: run name to the ask key it is
   *  parked on. `forge_ask` sets this itself (F3), the same way `AskUserQuestion` does. */
  parked: Map<string, string>;
  gotchas: Gotchas;
}

/**
 * The five tool handlers a worker's session talks back through, built as their own
 * function so a specimen can call `onAsk` directly with no SDK, no live session, and no MCP
 * server involved (F3): `buildForgeMcpServer` wires these into the SDK's own in-process
 * tool server, and a fake `queryFn`-driven stream never actually invokes it, only the
 * tool-use/tool-result messages that server would have produced.
 *
 * `forge_ask` parks the run through `parkRun`, exactly as `AskUserQuestion` does. Before
 * F3, it raised the inbox entry and journaled `forge.ask` but never called `parkRun`, so a
 * run that asked through the tool rather than the SDK's own permission prompt parked
 * nothing: the next tool call went straight through.
 */
export function buildForgeToolHandlers(deps: ForgeHandlerDeps): ForgeToolHandlers {
  return {
    onDone: (input) => {
      deps.journal.append({ event: 'forge.done', run: deps.run, actor: 'worker', evidence: input.evidence });
    },
    onHandoff: (input) => {
      deps.journal.append({ event: 'forge.handoff', run: deps.run, actor: 'worker', packet: input.packet });
    },
    onAsk: (input) => {
      const entry = deps.inbox.raise({
        run: deps.run, goal: deps.goal, actionTarget: 'forge_ask',
        question: input.question, options: input.options, kind: input.kind,
      });
      parkRun(deps, deps.run, entry);
      deps.journal.append({
        event: 'forge.ask', run: deps.run, actor: 'worker', question: input.question,
      });
    },
    onGotcha: (input) => {
      deps.gotchas.file({ run: deps.run, ...input });
    },
    onReport: (input) => {
      deps.journal.append({ event: 'forge.report', run: deps.run, actor: 'worker', ...redactFields(input) });
    },
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
  /**
   * Reads whether the branch in `cwd` still applies to its base, after a push or a PR
   * open (B.3.9). Defaults to running `gh pr view --json mergeable` for real; a specimen
   * overrides this rather than the exec call underneath it.
   */
  checkDrift?: (cwd: string) => Promise<Mergeable | MergeableRead>;
  /**
   * Where an auth or rate-limit `gh` failure goes, alongside the ask raised on the board.
   * `forge run` wires a real `CredentialHorizon`, which takes the single-flight login
   * lock and parks under `credential:<account>` on a second lapse.
   *
   * That park is not self-clearing today. `warden-tick.ts:359-365` would clear it, but it
   * is gated on `credentialHorizon` and `openCredentialAccounts`, and `forge up` passes
   * neither, so nothing calls `CredentialHorizon.tick()`. The ask on the board is what a
   * person actually answers; treat the park as bookkeeping until that tick is wired.
   */
  credentialHorizon?: CredentialLapseSink;
  /** The credential a `gh` lapse parks behind. `github` matches the console's own
   *  integration row id, which is the only other place this credential is named. */
  ghAccount?: string;
  /**
   * I16: the clock `resolveMergeable` retries an UNKNOWN read against. Defaults to a
   * real 10s-interval, 90s-window wait; a specimen overrides this with a virtual clock
   * so a retry never sleeps for real (the item's own falsifier).
   */
  driftClock?: DriftClock;
  /**
   * P4.7/I8: read fresh on every tool call by the PreToolUse hook. Undefined means no
   * caller wired the kill switch to this engine -- `forge run` always does; a specimen
   * with nothing to say about stopping needs no fake.
   */
  killSwitch?: () => boolean;
  /**
   * I12: called the moment the SDK's `system`/`init` message names this session, not
   * after the segment's first turn finishes. `Worker`'s own `onSessionStarted` fires
   * only once `run()` resolves, which is too late for a process killed mid-segment: the
   * registry row and the lane never learn the session id, and `reconcileRegistry` can
   * only report that none was recorded rather than resume the run on it.
   */
  onSessionStarted?: (run: string, sessionId: string, model: string) => void;
}

async function ghDriftCheck(cwd: string): Promise<MergeableRead> {
  // `baseRefName` comes off the same call as the mergeable state. The base a question
  // names has to be the pull request's own base, and a separate call for it can fail on
  // its own and leave the two disagreeing about the same branch.
  const result = await execRun({
    argv: ['gh', 'pr', 'view', '--json', 'mergeable,baseRefName'], cwd, owner: 'drift', cls: 'script',
  });
  // Redacted before it is stored, not before it is shown. `gh` prints a token in some
  // error URLs, and a `MergeableRead` is carried far enough from here that the only
  // reliable place to scrub it is where it is created.
  return readMergeableDetailed(redact(result.tail));
}

/** The one method the drift path needs from `CredentialHorizon`, typed narrowly so a
 *  specimen fakes a method rather than the whole class's login-flow dependencies. */
export interface CredentialLapseSink {
  onLapse(account: string, run: string, incarnation: Incarnation): Promise<'started' | 'parked'>;
}

/** This process, as `CredentialHorizon` identifies whoever is running a login flow.
 *  `process.uptime()` is the OS's own start time, not when this run was journaled. */
function thisIncarnation(): Incarnation {
  return { pid: process.pid, startedAt: Math.round(Date.now() - process.uptime() * 1000) };
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
   * The one `Inbox` this instance ever writes park entries into or reads them back from.
   * Shared across every `run()` call on this instance (F1), not recreated per call: the
   * worker's own poll for an answer (`EngineLike.inbox`) has to see the exact same on-disk
   * directory `canUseTool`, `forge_ask` and the PreToolUse hook already write into.
   */
  private readonly sharedInbox: Inbox;

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
    this.sharedInbox = new Inbox(deps.inboxDir);
  }

  /** The ask key this run is parked on, per `EngineLike.parkedOn` (F1). */
  parkedOn(run: string): string | undefined {
    return this.parked.get(run);
  }

  /** Clears this run's park state, per `EngineLike.clearPark` (F1): for the worker's own
   *  in-process resume, never for a separate `forge answer` process, which goes through
   *  `answer()` instead. */
  clearPark(run: string): void {
    this.parked.delete(run);
  }

  /** The shared `Inbox`, per `EngineLike.inbox` (F1): the same directory `canUseTool`,
   *  `forge_ask` and the PreToolUse hook read and write park entries into. */
  get inbox(): Inbox {
    return this.sharedInbox;
  }

  async run(request: SessionRequest): Promise<SessionResult> {
    this.started.push(request);
    const goal = request.goal ?? request.run;

    const workerOptions = buildWorkerOptions({
      model: request.model,
      prompt: request.prompt,
      cwd: request.cwd,
      maxTurns: request.maxTurns,
      env: request.env,
      ...(request.resume ? { resume: request.resume } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      ...(request.configDir ? { configDir: request.configDir } : {}),
    });

    const journal = this.journal;
    const inbox = this.sharedInbox;
    const gotchas = new Gotchas(this.deps.gotchasDir, this.deps.journalPath);

    const handlers = buildForgeToolHandlers({
      run: request.run, goal, inbox, journal, parked: this.parked, gotchas,
    });

    // Each assistant message's usage already carries the whole context of that turn --
    // uncached input plus cache read plus cache creation is the entire prompt that turn
    // re-read, not an increment on top of the last one. So the ceiling (and the context
    // this loop journals) reads the latest message's own usage, never a running sum:
    // summing two 140,000-token requests would read 280,000 and hand off under a
    // 150,000 ceiling for a session whose real context is 140,000. Cost is tracked
    // separately, per turn, from each turn's own `usage` (see journal.ts's `costOf`),
    // so it never needs a cumulative context total either.
    let latestContext = 0;
    // Sticky once true: set by a usage event at or past request.ceiling, checked by the
    // PreToolUse hook below. This is what makes the deny happen inside the turn a tool
    // call arrives in, rather than only after Worker sees the whole segment's result.
    let ceilingHit = false;
    // What the inbox hook just delivered, watched for one assistant message to see
    // whether it was acknowledged (B.3.7). Cleared after that one check either way: this
    // is a one-shot window on "the next assistant message", not an open-ended watch.
    let pendingAck: { ids: string[]; text: string } | undefined;
    // True once any Bash call in this session ran `git commit`: the stuck rule (B.3.8)
    // watches this across the whole session, not per turn or per segment.
    let committed = false;

    // toEngineConfig carries the mapping every specimen in sdkengine.test.ts already
    // pins (env, maxTurns, effort, resume); the three fields below are the ones a real
    // run needs beyond that base, which toEngineConfig alone cannot build because they
    // close over this request's own journal, inbox and park state.
    const engineConfig: EngineConfig = {
      ...toEngineConfig(workerOptions),
      mcpServers: { forge: buildForgeMcpServer(handlers) },
      canUseTool: buildCanUseTool({ run: request.run, goal, inbox, journal, parked: this.parked }) as never,
      onToolCall: buildPreToolUseHook({
        run: request.run, goal, journal, parked: this.parked, inbox, deliverVia: this.deliverVia,
        ceilingHit: () => ceilingHit,
        killSwitchHit: this.deps.killSwitch,
        onDelivered: (ids, text) => { pendingAck = { ids, text }; },
        runCwd: request.cwd,
      }),
    };

    const engine = new Engine(this.deps.queryFn);
    engine.start(engineConfig);
    this.liveEngines.set(request.run, engine);
    // Named per call id rather than per segment: a tool's result event carries only the
    // id it answers, not the tool's name, so the name has to be remembered from the
    // matching tool-use to journal a tool.end a reader can act on.
    const toolNameById = new Map<string, string>();
    const bashCommandById = new Map<string, string>();
    const checkDrift = this.deps.checkDrift ?? ghDriftCheck;
    // A specimen may hand back a bare state instead of a full read; normalising here
    // keeps every caller below on one shape rather than branching per call site.
    const readDrift = async (cwd: string): Promise<MergeableRead> => {
      const answer = await checkDrift(cwd);
      return typeof answer === 'string' ? { state: answer } : answer;
    };
    const credentialHorizon = this.deps.credentialHorizon;
    const ghAccount = this.deps.ghAccount ?? 'github';

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
          case 'session-started':
            // I12: the registry row and the lane learn the session id right here, on the
            // SDK's own init message, rather than after `runSegment` resolves. A process
            // killed mid-segment (P5.5: 47s after `run.started`) still leaves a row
            // `reconcileRegistry` can resume, instead of one it can only report on.
            this.deps.onSessionStarted?.(request.run, event.sessionId, event.model);
            break;
          case 'usage':
            // A subagent's own Task-tool conversation, not the main loop this ceiling and
            // this turn stream belong to: its tokens are real spend (journaled below, so
            // replay's cost fold still counts them) but not context the main loop is
            // carrying, and it is not a turn of the main loop's own stream either.
            if (event.parentToolUseId) {
              journal.append({
                event: 'subagent.usage', run: request.run, actor: 'worker', model: event.model,
                usage: {
                  input: event.input, cacheRead: event.cacheRead,
                  cacheCreation: event.cacheCreation, output: event.output,
                },
              });
              break;
            }
            flush();
            latestContext = event.input + event.cacheRead + event.cacheCreation;
            if (request.ceiling !== undefined && latestContext >= request.ceiling) ceilingHit = true;
            pending = {
              text: '',
              context: latestContext,
              model: event.model,
              usage: {
                input: event.input, cacheRead: event.cacheRead,
                cacheCreation: event.cacheCreation, output: event.output,
              },
            };
            break;
          case 'assistant-text':
            if (pending) pending.text += event.text;
            if (pendingAck) {
              // The one-shot window: whether this message (the next one after delivery)
              // echoed the delivered text, checked once and then closed regardless.
              if (pending && pendingAck.text && pending.text.includes(pendingAck.text)) {
                for (const id of pendingAck.ids) {
                  journal.append({
                    event: 'inbox.acknowledged', run: request.run, actor: 'worker', messageId: id,
                  });
                }
              }
              pendingAck = undefined;
            }
            break;
          case 'tool-use':
            toolNameById.set(event.id, event.name);
            {
              // The target (file, pattern, first line of a command) travels with the row so
              // the warden's conformance judge sees what the call was about, not just its name.
              const target = toolTarget(event.name, event.input);
              if (event.name === 'Bash' && typeof event.input['command'] === 'string') {
                // The class travels with the row so the warden measures this call against
                // the budget its command deserves, not `script`'s 120 s (`command-class.ts`).
                journal.append({ event: 'tool.start', run: request.run, actor: 'worker', tool: event.name, cls: classifyCommand(event.input['command']), ...(target ? { target } : {}) });
              } else {
                journal.append({ event: 'tool.start', run: request.run, actor: 'worker', tool: event.name, ...(target ? { target } : {}) });
              }
            }
            if (event.name === 'Bash' && typeof event.input['command'] === 'string') {
              const command = event.input['command'];
              bashCommandById.set(event.id, command);
              if (invokesCommand(command, 'git', 'commit')) committed = true;
            }
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
          case 'tool-result': {
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
            const bashCommand = bashCommandById.get(event.id);
            if (bashCommand && !event.isError
              && (invokesCommand(bashCommand, 'git', 'push') || invokesCommand(bashCommand, 'gh', 'pr', 'create'))) {
              // Fire-and-forget: drift is checked after the push or PR open resolves, but
              // nothing in the turn stream waits on it. GitHub computes a PR's mergeable
              // state asynchronously, so the read right after a push or a PR open is
              // routinely UNKNOWN for a branch that is only seconds old (I16); resolveMergeable
              // retries that read every 10s for up to 90s before treating it as an answer.
              // A confirmed conflict raises at once -- there is nothing to wait for. A
              // MERGEABLE result clears any drift blocker this run raised earlier, whichever
              // wording (CONFLICTING or a since-exhausted UNKNOWN window) it carried.
              void resolveMergeableRead(() => readDrift(request.cwd), this.deps.driftClock).then(async (read) => {
                const outcome = classifyDriftRead(request.run, read, ghAccount);

                // An expired token and a rate limit both read UNKNOWN, and neither is
                // something a rebase can clear. Asking about the base branch here puts a
                // person on a path with no end to it, re-raised on every push. It is a
                // credential problem, so it goes where credential problems go.
                if (outcome.kind === 'credential-lapse') {
                  journal.append({
                    event: 'note', run: request.run, actor: 'runner',
                    note: `drift check hit ${read.reason === 'auth' ? 'an auth' : 'a rate-limit'} `
                      + `failure on ${outcome.account}; recorded as a credential lapse `
                      + 'rather than base drift',
                  });
                  // The entry a person answers. `onLapse` starts a login flow and, on a
                  // second lapse, parks under `credential:<account>` -- but nothing calls
                  // `CredentialHorizon.tick()` in the shipped binary, so neither the park
                  // nor the lock is cleared by anything except the process exiting. Raise
                  // the ask first, so the way out exists whatever the horizon does.
                  // `goal` rather than the segment name alone. A handoff renames the
                  // segment, and answer delivery reads `entry.goals`, so an ask addressed
                  // only to `goal-2` never reaches the session that is live. The key is
                  // unaffected: `askKey` scopes a blocker on wording alone.
                  const ask = { ...credentialBlocker(request.run, outcome.account, outcome.reason), goal };
                  const entry = inbox.raise(ask);
                  journal.append({
                    event: 'run.blocked', run: request.run, actor: 'runner', reason: ask.question,
                  });
                  // The ask says to answer it before carrying on, so the run has to
                  // actually stop. Without this the board shows a blocked run that is
                  // still taking tool calls with a credential that cannot work, and an
                  // answer arrives for a session that has already finished.
                  parkRun({ parked: this.parked, journal }, request.run, entry);
                  // Only an auth failure goes to the login flow. A rate limit clears with
                  // time, and `onLapse` would take the single-flight login lock, tell
                  // Aaron the account "needs a fresh login", and hold that lock against a
                  // genuinely expired token on the same account that does need it.
                  if (outcome.reason !== 'auth' || !credentialHorizon) return;
                  const disposition = await credentialHorizon.onLapse(
                    outcome.account, request.run, thisIncarnation(),
                  );
                  journal.append({
                    event: 'note', run: request.run, actor: 'runner',
                    note: `credential horizon ${disposition} the login flow for ${outcome.account}`,
                  });
                  return;
                }

                if (outcome.kind === 'clear') {
                  // Every open base-drift ask this run is behind, found by reading the
                  // inbox rather than by rebuilding the wording that was used to raise
                  // it. The wording carries the base branch and the key is a hash of the
                  // wording, so a pull request retargeted between two reads leaves an ask
                  // no reconstruction from the current read can name. That ask sat open
                  // on a branch that was already mergeable.
                  for (const entry of inbox.open()) {
                    // By goal as well as by segment name. A blocker raised before a
                    // handoff records the predecessor's name, and the successor that
                    // rebases and pushes something mergeable runs under a different one.
                    // Matching on the segment alone left the resolved conflict on the
                    // board with nothing able to clear it.
                    const mine = entry.runs.includes(request.run) || entry.goals.includes(goal);
                    if (!mine) continue;
                    if (!/^Base drift\b/.test(entry.question)) continue;
                    inbox.answer(entry.key, 'cleared: a later read found the branch mergeable');
                    journal.append({
                      event: 'run.unblocked', run: request.run, actor: 'runner', reason: entry.question,
                    });
                  }
                  return;
                }

                inbox.raise({ ...outcome.ask, goal });
                journal.append({
                  event: 'run.blocked', run: request.run, actor: 'runner', reason: outcome.ask.question,
                });
              }).catch((error) => {
                journal.append({
                  event: 'engine.error', run: request.run, actor: 'runner',
                  message: `drift check failed: ${(error as Error).message}`, fatal: false,
                });
              });
            }
            break;
          }
          case 'result-usage':
            // The SDK result message's own per-model totals, journaled on this
            // segment's end row for the Governor's burn ledger (P4.2, `governor.ts`'s
            // `buildBurnLedger`). Emitted before `turn-complete` by the adapter, so this
            // case always runs while the listener below is still attached.
            journal.append({ event: 'result.usage', run: request.run, actor: 'worker', modelUsage: event.modelUsage });
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
        deliverViaStream(engine, goal, promptText, journal);
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
      get committed() { return committed; },
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

  /**
   * Releases the journal handle and stops every live `Engine` this instance still holds
   * (F4). Call once the whole chain, not one session, is done.
   *
   * Before F4 this cleared `liveEngines` without ever calling `.stop()` on what it held, so
   * the SDK child process behind each one outlived the chain that opened it: the live probe
   * that found this saw `claude.exe`'s count go up by one and stay there after `forge run`
   * printed its verdict and the process never exited. The journal and the park map are
   * still cleared synchronously, so an immediate `replay()` right after this call, as the
   * existing suite does, sees the file closed whether or not the returned promise is
   * awaited; only stopping the engines themselves is asynchronous.
   */
  close(): Promise<void> {
    this.journal.close();
    const engines = [...this.liveEngines.values()];
    this.liveEngines.clear();
    this.parked.clear();
    return Promise.all(engines.map((engine) => engine.stop())).then(() => undefined);
  }
}

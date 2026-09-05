/**
 * One goal, run as a chain of bounded sessions.
 *
 * A Claude Code session only ever accumulates. Cache re-read is charged again on every
 * single turn, so a worker at 500,000 tokens pays several times one at 150,000 for the
 * same work, and reasons worse for it because what it needs is buried under what it has
 * already done. On 2026-09-03 every lane ran to 500,000 and the bill was about $6,250 in
 * four hours.
 *
 * So a session here has a ceiling. At the ceiling the worker asks the session to write a
 * handoff packet and starts a successor seeded with it, on the same model. The chain
 * continues; the context does not. Nothing in this file takes a failure count, which is
 * what makes "no escalation by retry" a property of the code rather than a promise.
 *
 * The engine is injected. Every specimen runs against a fake stream, so the suite spends
 * nothing and still exercises the loop that decides the money.
 */
import { tierOfBrief, contextFor, effortFor, modelFor, modelIdFor, turnsFor } from './policy.js';
import { Journal, replay } from './journal.js';
import { run as execRun, type RunRequest, type RunResult } from './exec.js';
import { parseShellPrefix } from './chain-env.js';
import type { Inbox } from './inbox.js';
import { asRunId, type Actuator } from './contracts.js';
import { checkConformance, isRateLimitMessage, WindowGate } from './governor.js';
import { clearParkRecord } from './parkrecord.js';

/**
 * Markers a session inherits from the session that spawned it.
 *
 * A child that keeps them saves no transcript, and a worker with no transcript is a
 * worker nothing can classify: no context reading, no cost, no evidence it ran. Read off
 * the old launcher, which learned each one the hard way.
 */
export const INHERITED = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
] as const;

/**
 * The environment a worker subprocess gets.
 *
 * ANTHROPIC_API_KEY is removed as well, and not because it is one of the nine: with a key
 * present the child bills the API account instead of using the subscription login, which
 * is a bill nobody is watching rather than a quota that stops.
 */
export function workerEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...parent };
  for (const name of INHERITED) delete clean[name];
  delete clean['ANTHROPIC_API_KEY'];
  return clean;
}

/** One assistant turn as a fake stream reports it. */
export interface FakeTurn {
  text: string;
  /** Tokens this turn re-read: input plus cache read plus cache creation. */
  context: number;
  usage?: { input: number; cacheRead: number; cacheCreation: number; output: number };
  /** Set when the session called forge_done. */
  done?: boolean;
  /** The model that actually served this message, which a fallback reroute can make
   *  different from the one the class asked for. */
  model?: string;
}

export interface SessionRequest {
  /** This segment's own name: `goal` for the first session, `goal-2`, `goal-3` ... for
   *  every successor a handoff starts. Scopes the journal rows this segment writes. */
  run: string;
  /** The goal's own stable id, unchanged across every handoff in the chain. Scopes the
   *  inbox, so a message sent to the goal id reaches whichever segment is live. Falls
   *  back to `run` when omitted, which is what a first session (run === goal) needs. */
  goal?: string;
  model: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  resume?: string;
  /** Omitted for the implement classes (B.3.8, the 2026-09-04 12:58 decision): the class
   *  ceiling and the stuck rule are what bound an implement run, not a turn count. */
  maxTurns?: number;
  /** The class ceiling. Below this, a turn's own tool calls run; at or past it, every
   *  tool call on this session denies until a successor starts (see B.3.3). */
  ceiling?: number;
  /** How much effort the class asks the model to spend, from model-policy.json. */
  effort?: string;
}

export interface SessionResult {
  sessionId: string;
  turns: FakeTurn[];
  /**
   * Another prompt into this session, which is already open.
   *
   * The handoff request goes through here rather than through `run`. Starting a second
   * session to ask for the packet would throw away the context the packet is made of,
   * and would double the spawn count behind a suite that still looked green.
   */
  send?(prompt: string): Promise<FakeTurn[]>;
  /** True when this session ran a `git commit`. What the stuck rule (B.3.8) watches for:
   *  three sessions in a row with none is a chain going nowhere, not just a slow one. */
  committed?: boolean;
}

export interface EngineLike {
  started: SessionRequest[];
  run(config: SessionRequest): Promise<SessionResult>;
  /**
   * The ask key this run is parked on, if the engine tracks park state (F1/F3). `SdkEngine`
   * implements this. A fake with no park concept can leave it out, and the worker falls
   * back to treating a segment that ended with no `done` and no ceiling as a plain stop.
   */
  parkedOn?(run: string): string | undefined;
  /**
   * Clears this run's park state once the worker has resumed it in-process (F1). Separate
   * from `SdkEngine.answer()`, which is for a different `forge answer` process to call: the
   * worker never calls `answer()` on its own engine. It resumes the session directly through
   * `SessionResult.send` and only then clears the park it was waiting on.
   */
  clearPark?(run: string): void;
  /**
   * The shared `Inbox` this engine writes park entries into, so the worker can poll the
   * same file a separate `forge answer` process writes the answer into (F1).
   */
  inbox?: Inbox;
  /** Shuts down whatever this engine's sessions are still holding open, mainly the SDK
   *  child process behind a live session (F4). Every caller awaits it before returning. */
  close?(): Promise<void> | void;
}

export interface WorkerConfig {
  run: string;
  brief: string;
  briefPath: string;
  cwd: string;
  journalPath: string;
  engine: EngineLike;
  /** Overrides the class ceiling. The cutover smoke goal forces this to 60,000. */
  maxContext?: number;
  maxTurns?: number;
  /** How many successors a chain may have before it parks rather than continuing. */
  maxSessions?: number;
  parentEnv?: NodeJS.ProcessEnv;
  ticket?: string;
  /** Runs a brief's declared verification commands. Overridable so a specimen can record
   *  calls instead of spawning a real process; defaults to `exec.ts`'s own `run`. */
  exec?: (request: RunRequest) => Promise<RunResult>;
  /** The shell a brief's verification command runs through. A verify command routinely
   *  chains steps with `&&` and calls `npm` (a `.cmd` shim on Windows), so it must go
   *  through a shell or it dies with `spawn npm ENOENT` -- the failure that parked the
   *  first live chain run whose own command passed by hand. Defaults to
   *  `FORGE_WORKTREE_SHELL` (a prefix such as a bash path plus `-c`), else the platform's
   *  own shell. Overridable so a specimen records what it was handed. */
  verifyShell?: boolean | string[];
  /** Called the moment a session in this chain has opened, so a caller (the registry, in
   *  cli.ts's `run`) can persist the session id before a crash could ever lose it. */
  onSessionStarted?: (run: string, sessionId: string, model: string) => void;
  /** How often to re-check a park while waiting for an answer (F1). Defaults to 2,000ms; a
   *  specimen overrides this so a park-and-answer round trip does not cost real seconds. */
  pollIntervalMs?: number;
  /** Read fresh on every poll while parked; `true` ends the wait with no answer. Defaults to
   *  never engaged. `forge run`'s own wiring in cli.ts passes the real kill switch in; a
   *  specimen that does not care about it needs no fake. */
  killSwitch?: () => boolean;
  /** Item 8, 2026-09-05: for a probe or smoke run only (`cli.ts`'s `run` command refuses
   *  the flag for any brief under a real goals directory), answers every ask this run
   *  raises with this exact text, in-process, the moment it is raised -- no second
   *  process, no person, no poll. Journals `ask.auto-answered` with the text used. */
  autoAnswer?: string;
  /** P4.7/I3, wired live by P4.7/I9: the Governor's per-turn conformance check parks
   *  through this. `forge run` always builds a real `WardenActuator` and passes it here;
   *  undefined only in a specimen with nothing to say about parking. Either way a
   *  mismatch is journaled by `checkConformance`'s own event -- an actuator only decides
   *  whether anything acts on it. */
  actuator?: Actuator;
  /** P4.7/I3: pass one gate to share it across more than one run launched in the same
   *  process; a `Worker` with none injected builds its own. Either way the gate is
   *  in-memory and per-process -- a pause never crosses a `forge run` process boundary,
   *  which is this wiring's own named limitation. */
  windowGate?: WindowGate;
}

export interface WorkerResult {
  run: string;
  model: string;
  className: string;
  sessions: string[];
  handoffs: number;
  turns: number;
  context: number;
  /**
   * `unverified` is what `forge_done` alone used to be treated as `done`: a brief with no
   * `## Verification` block never earns `done`, however clean the tool call looked.
   */
  verdict: 'done' | 'exhausted' | 'parked' | 'unverified';
}

/**
 * The commands a brief declares under a `## Verification` heading, one per line inside a
 * single fenced block. The block is the first fenced block that appears after the
 * heading and before the next heading -- prose between the heading and the fence (a
 * sentence of instructions, a "run this from the worktree root" line) is allowed, and
 * skipped, rather than treated as a missing block. A fence that only appears after the
 * next `##` heading belongs to that section, not this one, and does not count. Missing
 * entirely, or an empty block, both read as "nothing declared" -- there is no default
 * command to fall back to, because guessing one would be exactly the unproven `done`
 * this item exists to close off.
 */
export function verificationCommands(brief: string): string[] | undefined {
  const headingMatch = /^##[ \t]+Verification[ \t]*$/m.exec(brief);
  if (!headingMatch) return undefined;
  const afterHeading = brief.slice(headingMatch.index + headingMatch[0].length);
  const nextHeadingMatch = /^##[ \t]+\S/m.exec(afterHeading);
  const section = nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;
  const fenceMatch = /```[^\n]*\r?\n([\s\S]*?)```/.exec(section);
  if (!fenceMatch) return undefined;
  const lines = fenceMatch[1]!.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines : undefined;
}

/** A verification command, run and reported as pass or fail with what it printed. */
interface VerificationOutcome {
  command: string;
  ok: boolean;
  tail: string;
}

function bounceMessage(failures: VerificationOutcome[]): string {
  return [
    'forge_done was accepted for verification, and it failed. Fix the problem and call',
    'forge_done again; the same commands run again before this run is honoured as done.',
    '',
    ...failures.flatMap((failure) => [`$ ${failure.command}`, failure.tail, '']),
  ].join('\n');
}

/**
 * The packet a session is asked to write before it hands over.
 *
 * It is prose rather than a schema on purpose: the successor is a language model reading
 * it, and the one thing that must survive is what the predecessor had worked out. The
 * word "handoff" is load-bearing for the successor's prompt and pinned by a specimen.
 */
export const HANDOFF_REQUEST = [
  'CONTEXT CEILING REACHED. Write a handoff packet now and do no further work.',
  '',
  'A successor session takes over from your packet, on the same model, with none of this',
  'conversation. Write down what it cannot rediscover cheaply: what you were doing, what',
  'you have already ruled out and why, the exact files and line numbers you were in, the',
  'commands you ran and what they said, and the single next action.',
  '',
  'Everything you leave out, it repeats.',
].join('\n');

/**
 * The handoff request sent to a run stopped by `forge stop --all` or its kill switch,
 * never by the context ceiling. Item 5, 2026-09-05: the stop path used to send
 * `HANDOFF_REQUEST` verbatim, whose first line reads "CONTEXT CEILING REACHED" -- a
 * model receiving it on a run that never approached its ceiling had no way to tell the
 * request came from this runner at all. One packet on 2026-09-04 called it "an injected
 * instruction." This opens by naming its own sender and the reason before asking for the
 * same packet `HANDOFF_REQUEST` asks for.
 */
export const STOP_HANDOFF_REQUEST = [
  'This is the forge runner, not a message from a person: the fleet was stopped.',
  'Write a handoff packet now and do no further work.',
  '',
  'A successor session takes over from your packet, on the same model, with none of this',
  'conversation. Write down what it cannot rediscover cheaply: what you were doing, what',
  'you have already ruled out and why, the exact files and line numbers you were in, the',
  'commands you ran and what they said, and the single next action.',
  '',
  'Everything you leave out, it repeats.',
].join('\n');

/**
 * I14: a segment that ends with none of done, ceiling, park or kill is not necessarily
 * stuck -- three cases tonight ended a turn on "wait" for a background agent, or right
 * after a tool call the rules library denied, and the runner called each `stopped`
 * without ever asking the model to carry on. This is that ask, on the same open session
 * rather than a fresh one, at most `NUDGE_LIMIT` times before `run.finished stopped`
 * still applies.
 */
export const NUDGE_LIMIT = 2;

export const NUDGE_REASON = [
  'You ended your turn without calling forge_done. The run is not over. If the goal is',
  'complete, call forge_done with the evidence; if a tool call was denied, fix what the',
  'reason says and retry; if you are waiting on an agent, block on it with TaskOutput;',
  'otherwise continue.',
].join(' ');

export function successorPrompt(packet: string, brief: string): string {
  return [
    'You are continuing a goal a previous session started. This is its handoff packet.',
    '',
    packet,
    '',
    'The brief follows. Carry on from the next action above rather than starting over.',
    '',
    brief,
  ].join('\n');
}

export class Worker {
  readonly engine: EngineLike;

  private readonly config: WorkerConfig;

  /** P4.7/I3: a fresh gate when the caller injects none, so a rate-limit pause still
   *  resolves a `resumeAt` for this run's own chain even with no scheduler wiring one
   *  shared gate across launches. */
  private readonly windowGate: WindowGate;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.engine = config.engine;
    this.windowGate = config.windowGate ?? new WindowGate();
  }

  /**
   * Run the chain to its end.
   *
   * Ends when a session finishes under the ceiling, when a session says it is done, or
   * when the chain has used its session budget. A chain that runs out of sessions parks:
   * it does not get a bigger model, and it does not get more sessions for having failed.
   */
  async run(): Promise<WorkerResult> {
    const className = tierOfBrief(this.config.brief);
    const model = modelIdFor(modelFor(className));
    const effort = effortFor(className);
    const ceiling = this.config.maxContext ?? contextFor(className);
    // No turn cap on an implement run (B.3.8, the 2026-09-04 12:58 decision): the class
    // ceiling and the stuck rule below are what bound it, not a count of turns that has
    // no relationship to how much a goal actually needs.
    const isImplementClass = className === 'implement' || className === 'implement-hard';
    const maxTurns = this.config.maxTurns
      ?? (isImplementClass ? undefined : turnsFor(className));
    const maxSessions = this.config.maxSessions ?? (isImplementClass ? Number.POSITIVE_INFINITY : 10);
    const env = workerEnv(this.config.parentEnv ?? process.env);

    const journal = new Journal(this.config.journalPath);
    const sessions: string[] = [];
    let handoffs = 0;
    let turns = 0;
    let context = 0;
    let verdict: WorkerResult['verdict'] = 'exhausted';
    let runName = this.config.run;
    let prompt = this.config.brief;
    let predecessor: string | undefined;
    // The stuck rule, replacing a bare session cap (B.3.8): a chain that keeps handing
    // off or stopping without ever committing is going nowhere, whatever its budget says.
    let sessionsSinceCommit = 0;
    const staleSessions: string[] = [];
    // I13: a park record is cross-process ownership of `runs/<run>/park.json`, keyed by
    // name -- it has to be cleared here, the moment the name it names is done with, or a
    // resume of the same goal (`reconcileRegistry`) or a mid-loop answer-resume inherits
    // whatever a Warden wrote for a turn that is already over.
    const finishRun = (fields: Record<string, unknown>): void => {
      clearParkRecord(runName);
      journal.append({ event: 'run.finished', run: runName, actor: 'runner', ...fields });
    };

    try {
      for (let index = 0; index < maxSessions; index += 1) {
        journal.append({
          event: 'run.started',
          run: runName,
          actor: 'runner',
          model,
          className,
          maxContext: ceiling,
          ...(this.config.ticket ? { ticket: this.config.ticket } : {}),
          ...(predecessor ? { predecessor } : {}),
        });

        let session: SessionResult;
        try {
          session = await this.engine.run({
            run: runName, goal: this.config.run, model, prompt, env, cwd: this.config.cwd,
            ...(maxTurns !== undefined ? { maxTurns } : {}),
            ceiling, effort,
          });
        } catch (error) {
          // An engine that throws (the subprocess exited, a fatal engine-error) must not
          // take this call down with it: the run is paused, honestly, with the error that
          // actually happened, rather than an uncaught rejection nothing downstream can
          // read as a run outcome at all.
          const message = error instanceof Error ? error.message : String(error);
          journal.append({
            event: 'engine.error', run: runName, actor: 'runner', message,
          });
          // P4.7/I3: the Governor's WindowGate, consulted on every rate-limit-shaped
          // engine error. Undefined `windowGate` (no scheduler wired one up) pauses this
          // run with a plain reason and no resumeAt, exactly as it did before this item.
          const resumeAt = isRateLimitMessage(message)
            ? this.windowGate.onRateLimitEvent(className, message, Date.now()).resumeAt
            : undefined;
          journal.append({
            event: 'run.paused', run: runName, actor: 'runner', reason: message,
            ...(resumeAt !== undefined ? { resumeAt } : {}),
          });
          verdict = 'exhausted';
          break;
        }
        sessions.push(session.sessionId);
        this.config.onSessionStarted?.(this.config.run, session.sessionId, model);

        let ceilingHit = false;
        let finished = false;
        let parkedWithoutAnswer = false;
        let killedWhileParked = false;
        let conformanceMismatch = false;
        // P4.7/I8: true once the kill switch is seen mid-segment, so the chain parks with
        // a packet and exits 2 rather than treating the segment as a plain stop or
        // continuing to a successor the way an ordinary ceiling hit would.
        let killedMidTurn = false;
        let pendingTurns = session.turns;
        // I14: per session (this outer loop's own iteration), not per run -- a successor
        // opened after a handoff gets its own fresh count, the same as a resumed one.
        let nudges = 0;
        // A segment that ends with neither `done` nor the ceiling hit is not necessarily a
        // stop: the model may have hit an `AskUserQuestion` or `forge_ask` and parked (F1).
        // That is not this segment failing to finish, it is this segment waiting on a
        // person, so the loop below waits for the answer and keeps going on the SAME open
        // session rather than reporting `stopped` the moment the model's own turn ends.
        for (;;) {
          for (const turn of pendingTurns) {
            turns += 1;
            context = turn.context;
            journal.append({
              event: 'turn.end',
              run: runName,
              actor: 'worker',
              context: turn.context,
              model,
              // `model` above is the class-selected model this run was asked to open on;
              // `messageModel` is what the SDK actually reported serving this specific
              // message with, which a fallback reroute can make different.
              ...(turn.model ? { messageModel: turn.model } : {}),
              ...(turn.usage ? { usage: turn.usage } : {}),
            });
            // P4.7/I3: the Governor's per-turn conformance check, in the very turn a
            // served model stops matching this run's class -- never after N turns.
            // Undefined `turn.model` (a fake with no messageModel, or a fallback the SDK
            // never reports) skips the check rather than comparing against nothing.
            if (turn.model && this.config.actuator) {
              const verdict = checkConformance(runName, className, turn.model);
              if (!verdict.conforms) {
                await this.config.actuator.park(asRunId(runName), 'model-mismatch');
                journal.append(verdict.event!);
                conformanceMismatch = true;
                break;
              }
            }
            if (turn.done) {
              finished = true;
              break;
            }
            if (turn.context >= ceiling) {
              ceilingHit = true;
              break;
            }
            // P4.7/I8: checked after done and the ceiling, so a turn that already
            // finished or already needs a handoff for its own reason is not relabelled a
            // kill; checked every turn, not only once, since `forge stop --all` can land
            // between any two turns of a long segment.
            if (this.config.killSwitch?.()) {
              killedMidTurn = true;
              break;
            }
          }
          if (conformanceMismatch) break;
          if (killedMidTurn) break;
          if (finished || ceilingHit) break;

          const key = this.engine.parkedOn?.(runName);
          if (!key) {
            if (nudges < NUDGE_LIMIT && session.send) {
              nudges += 1;
              // A denied tool call is very rarely the literal last row: the turn it
              // happened in still ends normally and journals its own `turn.end` right
              // after. So this looks for the most recent `rule.denied` anywhere in the
              // CURRENT segment (since this run's own `run.started`), not only the
              // single last event.
              const state = replay(this.config.journalPath);
              const runEvents = state.events.filter((event) => event.run === runName);
              const sinceStart = runEvents.slice(
                runEvents.map((event) => event.event).lastIndexOf('run.started') + 1,
              );
              const lastDenial = [...sinceStart].reverse().find((event) => event.event === 'rule.denied');
              const reason = lastDenial
                ? `${NUDGE_REASON} The last tool call was denied for: "${String(lastDenial['reason'] ?? '')}".`
                : NUDGE_REASON;
              journal.append({ event: 'run.nudged', run: runName, actor: 'runner', reason, attempt: nudges });
              pendingTurns = await session.send(reason);
              continue;
            }
            break;
          }

          // Item 8, 2026-09-05: a probe or smoke run answers its own ask, in-process,
          // rather than waiting on a second process polling the same shared inbox. The
          // answer is written before the wait even starts, so `waitForAnswer`'s first
          // poll already finds it and there is never an actual wait.
          if (this.config.autoAnswer !== undefined) {
            this.engine.inbox?.answer(key, this.config.autoAnswer);
            journal.append({
              event: 'ask.auto-answered', run: runName, actor: 'runner',
              key, answer: this.config.autoAnswer,
            });
          }

          const outcome = await this.waitForAnswer(key);
          if (outcome !== 'answered') {
            parkedWithoutAnswer = true;
            killedWhileParked = outcome === 'killed';
            break;
          }
          this.engine.clearPark?.(runName);
          clearParkRecord(runName);
          journal.append({ event: 'run.resumed', run: runName, actor: 'console', key });
          if (!session.send) break;
          pendingTurns = await session.send(this.engine.inbox?.resumePrompt(key) ?? '');
        }

        if (conformanceMismatch) {
          finishRun({ verdict: 'parked', reason: 'model-mismatch' });
          verdict = 'parked';
          break;
        }

        if (parkedWithoutAnswer) {
          // P4.7/I8: a park whose wait ended because `forge stop --all` engaged the kill
          // switch, rather than an answer or a SIGINT, is asked for a packet exactly as a
          // ceiling handoff is, and journals its own `run.parked` carrying it -- never
          // just the bare `run.finished` a plain unanswered park leaves behind, which is
          // silent on whether anything survives the stop.
          if (killedWhileParked) {
            const packet = await this.requestHandoff(runName, session, journal);
            journal.append({
              event: 'run.parked', run: runName, actor: 'runner',
              reason: 'kill switch engaged while parked', packet,
            });
          }
          finishRun({ verdict: 'parked' });
          verdict = 'parked';
          break;
        }

        if (killedMidTurn) {
          const packet = await this.requestHandoff(runName, session, journal);
          journal.append({
            event: 'run.parked', run: runName, actor: 'runner',
            reason: 'kill switch engaged', packet,
          });
          finishRun({ verdict: 'parked' });
          verdict = 'parked';
          break;
        }

        if (finished) {
          verdict = await this.verifyDone(runName, session, journal, model);
          break;
        }

        if (session.committed) {
          sessionsSinceCommit = 0;
          staleSessions.length = 0;
        } else {
          sessionsSinceCommit += 1;
          staleSessions.push(runName);
        }
        if (sessionsSinceCommit >= 3) {
          const report = `three sessions without a commit: ${staleSessions.join(', ')}`;
          finishRun({ verdict: 'parked', report });
          verdict = 'parked';
          break;
        }

        if (!ceilingHit) {
          finishRun({ verdict: 'stopped' });
          verdict = sessions.length === 1 && turns === 0 ? 'parked' : 'exhausted';
          break;
        }

        if (index === maxSessions - 1) {
          // The ceiling was hit on the last session this chain is allowed. A handoff
          // packet with no successor to seed is a phantom: journaling run.handoff here
          // would claim a continuation that never starts. This is exhausted, plainly.
          finishRun({ verdict: 'exhausted' });
          verdict = 'exhausted';
          break;
        }

        // The ceiling, with sessions left in the budget. Ask for the packet, then
        // continue as a new run on the same model. The successor is a fresh name
        // (I13: never this one), so it starts with no park record of its own regardless
        // -- clearing this run's is still worth doing, since the same name can still
        // come back through a crash-resume later (`reconcileRegistry`).
        const successor = `${this.config.run}-${index + 2}`;
        const packet = await this.requestHandoff(runName, session, journal);
        clearParkRecord(runName);
        journal.append({
          event: 'run.handoff',
          run: runName,
          actor: 'worker',
          successor,
          reason: `context reached ${context} tokens, the ${className} class ceiling is ${ceiling}`,
        });
        handoffs += 1;
        predecessor = runName;
        runName = successor;
        prompt = successorPrompt(packet, this.config.brief);
      }
    } finally {
      journal.close();
    }

    return { run: this.config.run, model, className, sessions, handoffs, turns, context, verdict };
  }

  /**
   * `forge_done` was called and its result came back clean. This is what earns it a
   * `done` verdict instead of just taking the claim: a brief's `## Verification` commands
   * run for real, under `exec.ts`'s own budgets, and the run only counts as done once
   * they all come back green.
   *
   * A brief with no `## Verification` block has nothing to run and is `unverified`, never
   * `done`: guessing a command would be exactly the unproven claim this exists to close
   * off. A failing command goes back into the session as a message and the run bounces --
   * up to three verification attempts total, whether or not the model calls `forge_done`
   * again in between -- before it parks rather than continuing to spend on its own.
   */
  private async verifyDone(
    runName: string, session: SessionResult, journal: Journal, model: string,
  ): Promise<'done' | 'unverified' | 'parked'> {
    const commands = verificationCommands(this.config.brief);
    if (!commands) {
      clearParkRecord(runName);
      journal.append({ event: 'run.finished', run: runName, actor: 'runner', verdict: 'unverified' });
      return 'unverified';
    }

    const exec = this.config.exec ?? execRun;
    // A verify command that chains steps with `&&` and calls `npm` (a `.cmd` shim on
    // Windows) dies with `spawn npm ENOENT` when exec'd as a split argv, which parked the
    // first live chain run whose own command passed by hand. Route it through a shell only
    // when one is named -- `FORGE_WORKTREE_SHELL`, the same prefix the chain's worktree
    // setup reads. With none named (every unit run, and Linux CI), keep the direct exec:
    // splitting an already-shell-quoted line and rejoining it under `/bin/sh` mangles a
    // command like `node -e process.exit(0)`, so shell mode is opt-in, not the default.
    const verifyShell: boolean | string[] =
      this.config.verifyShell ?? parseShellPrefix(process.env['FORGE_WORKTREE_SHELL']);
    const useShell = Array.isArray(verifyShell) ? verifyShell.length > 0 : verifyShell;
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const outcomes: VerificationOutcome[] = [];
      for (const command of commands) {
        const base = { cwd: this.config.cwd, owner: runName, cls: 'verify' as const };
        const result = useShell
          ? await exec({ ...base, argv: [command], shell: verifyShell })
          : await exec({ ...base, argv: command.split(/\s+/).filter(Boolean) });
        outcomes.push({ command, ok: result.ok, tail: result.tail });
      }
      const failed = outcomes.filter((outcome) => !outcome.ok);
      if (!failed.length) {
        clearParkRecord(runName);
        journal.append({ event: 'run.finished', run: runName, actor: 'runner', verdict: 'done' });
        return 'done';
      }
      journal.append({
        event: 'run.verify-failed', run: runName, actor: 'runner', attempt,
        commands: failed.map((outcome) => outcome.command),
      });
      if (attempt === attempts || !session.send) break;
      const reply = await session.send(bounceMessage(failed));
      // The bounce is a real turn against the model and costs real tokens: skipping this
      // would undercount a run's spend by exactly the retries verification itself caused.
      for (const turn of reply) {
        journal.append({
          event: 'turn.end', run: runName, actor: 'worker', context: turn.context, model,
          ...(turn.model ? { messageModel: turn.model } : {}),
          ...(turn.usage ? { usage: turn.usage } : {}),
        });
      }
    }
    clearParkRecord(runName);
    journal.append({ event: 'run.finished', run: runName, actor: 'runner', verdict: 'parked' });
    return 'parked';
  }

  /**
   * Waits for a park to be answered (F1), polling the engine's shared `Inbox` on the
   * interval `pollIntervalMs` sets, with no overall timeout: a park waits for a person, for
   * as long as it takes. This never calls the engine's own `answer()` -- that path is for a
   * separate `forge answer` process, and the falsifier here is exactly a specimen that used
   * it instead of a second `Inbox` instance writing the file this one reads.
   *
   * Two things end the wait early, and both stop the run rather than the process: the kill
   * switch (`forge stop --all`, checked via `killSwitch` on the same interval) and a
   * `SIGINT`. Either resolves `'killed'` or `'interrupted'`, which the caller journals as a
   * clean `parked` verdict, exit 2.
   */
  private waitForAnswer(key: string): Promise<'answered' | 'killed' | 'interrupted'> {
    const inbox = this.engine.inbox;
    const pollIntervalMs = this.config.pollIntervalMs ?? 2000;
    const killSwitch = this.config.killSwitch ?? (() => false);
    return new Promise((resolve) => {
      let settled = false;
      const onSigint = () => finish('interrupted');
      const finish = (outcome: 'answered' | 'killed' | 'interrupted') => {
        if (settled) return;
        settled = true;
        process.off('SIGINT', onSigint);
        resolve(outcome);
      };
      process.once('SIGINT', onSigint);
      const poll = () => {
        if (settled) return;
        if (killSwitch()) {
          finish('killed');
          return;
        }
        if (inbox?.entry(key)?.answer !== undefined) {
          finish('answered');
          return;
        }
        setTimeout(poll, pollIntervalMs);
      };
      poll();
    });
  }

  /**
   * Ask the session at its ceiling for the packet.
   *
   * Asked of the session that holds the context, because that is the only place the
   * packet can come from. An engine that cannot take another prompt returns nothing, and
   * the successor is told plainly that it is starting blind rather than being handed a
   * confident-looking empty packet.
   */
  private async requestHandoff(run: string, session: SessionResult, journal: Journal): Promise<string> {
    if (!session.send) {
      return `(this engine cannot resume a session; run ${run} continues without a packet)`;
    }
    const reply = await session.send(HANDOFF_REQUEST);
    // The packet costs tokens too, and a reply this loop never journals is spend nothing
    // else will ever see: replay's cost fold only sees a usage field on an event it reads.
    for (const turn of reply) {
      if (!turn.usage) continue;
      journal.append({
        event: 'turn.end', run, actor: 'worker', context: turn.context,
        ...(turn.model ? { messageModel: turn.model } : {}), usage: turn.usage,
      });
    }
    const text = reply.map((turn) => turn.text).join('\n').trim();
    return text || `(the session at its ceiling wrote no packet; run ${run} continues blind)`;
  }
}

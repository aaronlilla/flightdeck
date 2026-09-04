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
import { tierOfBrief, contextFor, modelFor, modelIdFor, turnsFor } from './policy.js';
import { Journal } from './journal.js';
import { run as execRun, type RunRequest, type RunResult } from './exec.js';

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
  maxTurns: number;
  /** The class ceiling. Below this, a turn's own tool calls run; at or past it, every
   *  tool call on this session denies until a successor starts (see B.3.3). */
  ceiling?: number;
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
}

export interface EngineLike {
  started: SessionRequest[];
  run(config: SessionRequest): Promise<SessionResult>;
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
  /** Called the moment a session in this chain has opened, so a caller (the registry, in
   *  cli.ts's `run`) can persist the session id before a crash could ever lose it. */
  onSessionStarted?: (run: string, sessionId: string, model: string) => void;
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
 * single fenced block. Missing entirely, or an empty block, both read as "nothing
 * declared" -- there is no default command to fall back to, because guessing one would be
 * exactly the unproven `done` this item exists to close off.
 */
export function verificationCommands(brief: string): string[] | undefined {
  const match = /^##[ \t]+Verification[ \t]*\r?\n+```[^\n]*\r?\n([\s\S]*?)```/m.exec(brief);
  if (!match) return undefined;
  const lines = match[1]!.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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

  constructor(config: WorkerConfig) {
    this.config = config;
    this.engine = config.engine;
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
    const ceiling = this.config.maxContext ?? contextFor(className);
    const maxTurns = this.config.maxTurns ?? turnsFor(className);
    const maxSessions = this.config.maxSessions ?? 10;
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
            run: runName, goal: this.config.run, model, prompt, env, cwd: this.config.cwd, maxTurns,
            ceiling,
          });
        } catch (error) {
          // An engine that throws (the subprocess exited, a fatal engine-error) must not
          // take this call down with it: the run is paused, honestly, with the error that
          // actually happened, rather than an uncaught rejection nothing downstream can
          // read as a run outcome at all.
          const message = error instanceof Error ? error.message : String(error);
          journal.append({ event: 'run.paused', run: runName, actor: 'runner', reason: message });
          verdict = 'exhausted';
          break;
        }
        sessions.push(session.sessionId);
        this.config.onSessionStarted?.(this.config.run, session.sessionId, model);

        let ceilingHit = false;
        let finished = false;
        for (const turn of session.turns) {
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
          if (turn.done) {
            finished = true;
            break;
          }
          if (turn.context >= ceiling) {
            ceilingHit = true;
            break;
          }
        }

        if (finished) {
          verdict = await this.verifyDone(runName, session, journal);
          break;
        }

        if (!ceilingHit) {
          journal.append({
            event: 'run.finished', run: runName, actor: 'runner', verdict: 'stopped',
          });
          verdict = sessions.length === 1 && turns === 0 ? 'parked' : 'exhausted';
          break;
        }

        if (index === maxSessions - 1) {
          // The ceiling was hit on the last session this chain is allowed. A handoff
          // packet with no successor to seed is a phantom: journaling run.handoff here
          // would claim a continuation that never starts. This is exhausted, plainly.
          journal.append({
            event: 'run.finished', run: runName, actor: 'runner', verdict: 'exhausted',
          });
          verdict = 'exhausted';
          break;
        }

        // The ceiling, with sessions left in the budget. Ask for the packet, then
        // continue as a new run on the same model.
        const successor = `${this.config.run}-${index + 2}`;
        const packet = await this.requestHandoff(runName, session, journal);
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
    runName: string, session: SessionResult, journal: Journal,
  ): Promise<'done' | 'unverified' | 'parked'> {
    const commands = verificationCommands(this.config.brief);
    if (!commands) {
      journal.append({ event: 'run.finished', run: runName, actor: 'runner', verdict: 'unverified' });
      return 'unverified';
    }

    const exec = this.config.exec ?? execRun;
    const attempts = 3;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const outcomes: VerificationOutcome[] = [];
      for (const command of commands) {
        const result = await exec({
          argv: command.split(/\s+/).filter(Boolean), cwd: this.config.cwd, owner: runName, cls: 'verify',
        });
        outcomes.push({ command, ok: result.ok, tail: result.tail });
      }
      const failed = outcomes.filter((outcome) => !outcome.ok);
      if (!failed.length) {
        journal.append({ event: 'run.finished', run: runName, actor: 'runner', verdict: 'done' });
        return 'done';
      }
      journal.append({
        event: 'run.verify-failed', run: runName, actor: 'runner', attempt,
        commands: failed.map((outcome) => outcome.command),
      });
      if (attempt === attempts || !session.send) break;
      await session.send(bounceMessage(failed));
    }
    journal.append({ event: 'run.finished', run: runName, actor: 'runner', verdict: 'parked' });
    return 'parked';
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

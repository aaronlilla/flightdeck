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
}

export interface SessionRequest {
  /** The run this session belongs to. Scopes the inbox and the journal rows it writes. */
  run: string;
  model: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  resume?: string;
  maxTurns: number;
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
}

export interface WorkerResult {
  run: string;
  model: string;
  className: string;
  sessions: string[];
  handoffs: number;
  turns: number;
  context: number;
  verdict: 'done' | 'exhausted' | 'parked';
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

        const session = await this.engine.run({
          run: runName, model, prompt, env, cwd: this.config.cwd, maxTurns,
        });
        sessions.push(session.sessionId);

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
          journal.append({ event: 'run.finished', run: runName, actor: 'runner', verdict: 'done' });
          verdict = 'done';
          break;
        }

        if (!ceilingHit) {
          journal.append({
            event: 'run.finished', run: runName, actor: 'runner', verdict: 'stopped',
          });
          verdict = sessions.length === 1 && turns === 0 ? 'parked' : 'exhausted';
          break;
        }

        // The ceiling. Ask for the packet, then continue as a new run on the same model.
        const successor = `${this.config.run}-${index + 2}`;
        const packet = await this.requestHandoff(runName, session);
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
   * Ask the session at its ceiling for the packet.
   *
   * Asked of the session that holds the context, because that is the only place the
   * packet can come from. An engine that cannot take another prompt returns nothing, and
   * the successor is told plainly that it is starting blind rather than being handed a
   * confident-looking empty packet.
   */
  private async requestHandoff(run: string, session: SessionResult): Promise<string> {
    if (!session.send) {
      return `(this engine cannot resume a session; run ${run} continues without a packet)`;
    }
    const reply = await session.send(HANDOFF_REQUEST);
    const text = reply.map((turn) => turn.text).join('\n').trim();
    return text || `(the session at its ceiling wrote no packet; run ${run} continues blind)`;
  }
}

/**
 * The `claude` provider behind the `Reasoner` seam (`contracts.ts`).
 *
 * Every stream that needs a model answer -- the Warden tick's conformance drift, the
 * console router when `router.enabled`, and (once either grows a production call site
 * of its own) the Council orchestrator and the Intake planner -- looks up a `Reasoner`
 * and, until now, found nothing real behind it. This is that provider: one call is one
 * bounded, single-turn session through the same SDK `query` the runner uses
 * (`src/adapter/engine.ts`'s injectable `QueryFn`, via `Engine`), never a mock of this
 * class itself.
 *
 * `codex` stays unimplemented on purpose (Aaron, 2026-09-04 16:40: limit astra to what
 * absolutely matters) -- `CodexReasoner.call` returns a clear "not configured" error
 * without ever spawning a subprocess. The one sanctioned route to Codex is
 * `dev-harness/tools/codex_call.py` (`codex-side-agent` memory note), which this file
 * is not it.
 */
import { z } from 'zod';

import { Engine, type QueryFn } from '../adapter/engine.js';
import type { Provider, Reasoner } from './contracts.js';
import type { Journal } from './journal.js';
import { modelFor, modelIdFor, reasonerTimeoutMs } from './policy.js';
import { fleetConfigDir } from './paths.js';
import { workerEnv } from './worker.js';

/** The one JSON shape a `claude` reasoner call is ever allowed to answer with. There is
 *  no caller-supplied schema today: every seam that calls `Reasoner.call` reads a plain
 *  `text` back (`conformance-drift.ts`, `router.ts`), so this is the schema the
 *  `Reasoner` contract itself already commits to via its `Promise<{ text: string }>`
 *  return type, not a second one invented here. */
const REPLY_SCHEMA = z.object({ text: z.string() });

const SYSTEM_INSTRUCTIONS = [
  'Respond with exactly one JSON object and nothing else: no prose before it, no prose',
  'after it, no markdown fence. The object must be exactly this shape:',
  '{"text": "<your answer>"}',
].join(' ');

/** Raised when a reply is not valid JSON, or is valid JSON that does not match
 *  `REPLY_SCHEMA`. `raw` is the model's actual text, kept for the journal row and for
 *  whoever reads the failure afterward -- the one thing a thrown string would lose. */
export class ReasonerParseError extends Error {
  constructor(public readonly raw: string) {
    super('claude reasoner: the reply was not the required JSON object');
    this.name = 'ReasonerParseError';
  }
}

/** Raised when a call outruns `reasonerTimeoutMs()`. The session is asked to stop, but
 *  never awaited past this point (see `call()`): a stalled SDK subprocess must not turn
 *  a bounded call into an unbounded one. */
export class ReasonerTimeoutError extends Error {
  constructor(public readonly className: string, public readonly timeoutMs: number) {
    super(`claude reasoner: class ${className} timed out after ${timeoutMs}ms`);
    this.name = 'ReasonerTimeoutError';
  }
}

export interface ClaudeReasonerDeps {
  journal: Pick<Journal, 'append'>;
  /** The SDK's own `query`, or a fake. Every test in this suite injects one; production
   *  leaves this unset and gets the real thing (`Engine`'s own default). */
  queryFn?: QueryFn;
  /** Where the bounded session opens. Reasoning calls read no files and write none, so
   *  any real directory works; defaults to the process's own cwd. */
  cwd?: string;
  /** Passed straight to `fleetConfigDir`, so a specimen can pin either branch without
   *  depending on whether this machine happens to have a fleet login on it. */
  existsConfigDir?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Injectable clock, so the timeout specimen proves the budget without waiting on it. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  /** Overrides `model-policy.json`'s own path; a specimen points this at a fixture. */
  policyPath?: string;
}

export class ClaudeReasoner implements Reasoner {
  readonly provider: Provider = 'claude';

  constructor(private readonly deps: ClaudeReasonerDeps) {}

  async call(input: { className: string; prompt: string }): Promise<{ text: string }> {
    const { className, prompt } = input;
    const { policyPath } = this.deps;
    const model = modelIdFor(modelFor(className, policyPath), policyPath);
    const timeoutMs = reasonerTimeoutMs(policyPath);
    const now = this.deps.now ?? Date.now;
    const setTimeoutFn = this.deps.setTimeoutFn ?? setTimeout;
    const clearTimeoutFn = this.deps.clearTimeoutFn ?? clearTimeout;
    const startedAt = now();

    const env = workerEnv(this.deps.env ?? process.env);
    env['CLAUDE_CONFIG_DIR'] = fleetConfigDir(this.deps.existsConfigDir);

    const engine = new Engine(this.deps.queryFn);
    let text = '';
    let usage: { input: number; cacheRead: number; cacheCreation: number; output: number } | undefined;
    let servingModel: string | undefined;

    const outcome = new Promise<{ text: string }>((resolve, reject) => {
      const off = engine.onEvent((event) => {
        switch (event.type) {
          case 'usage':
            if (!event.parentToolUseId) {
              usage = {
                input: event.input, cacheRead: event.cacheRead,
                cacheCreation: event.cacheCreation, output: event.output,
              };
              servingModel = event.model;
            }
            break;
          case 'assistant-text':
            text += event.text;
            break;
          case 'turn-complete': {
            off();
            let parsedJson: unknown;
            try {
              parsedJson = JSON.parse(text.trim());
            } catch {
              reject(new ReasonerParseError(text));
              return;
            }
            const parsed = REPLY_SCHEMA.safeParse(parsedJson);
            if (!parsed.success) {
              reject(new ReasonerParseError(text));
              return;
            }
            resolve({ text: parsed.data.text });
            break;
          }
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
    });

    engine.start({
      cwd: this.deps.cwd ?? process.cwd(),
      model,
      permissionMode: 'bypassPermissions',
      allowedTools: [],
      maxTurns: 1,
      settingSources: [],
      env,
      canUseTool: async () => ({
        behavior: 'deny', message: 'the reasoner uses no tools',
      }) as never,
    });
    engine.send(`${SYSTEM_INSTRUCTIONS}\n\n${prompt}`);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeoutFn(() => {
        reject(new ReasonerTimeoutError(className, timeoutMs));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([outcome, timeout]);
      this.deps.journal.append({
        event: 'reasoner.call', actor: 'reasoner', provider: this.provider,
        class: className, model: servingModel ?? model, usage,
        durationMs: now() - startedAt, parsed: true,
      });
      return result;
    } catch (error) {
      const durationMs = now() - startedAt;
      if (error instanceof ReasonerTimeoutError) {
        this.deps.journal.append({
          event: 'reasoner.timeout', actor: 'reasoner', provider: this.provider,
          class: className, model, durationMs, timeoutMs,
        });
      } else if (error instanceof ReasonerParseError) {
        this.deps.journal.append({
          event: 'reasoner.call', actor: 'reasoner', provider: this.provider,
          class: className, model: servingModel ?? model, usage, durationMs,
          parsed: false, raw: error.raw,
        });
      } else {
        this.deps.journal.append({
          event: 'reasoner.call', actor: 'reasoner', provider: this.provider,
          class: className, model: servingModel ?? model, usage, durationMs,
          parsed: false, error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      if (timer) clearTimeoutFn(timer);
      // Fire-and-forget: a stalled SDK subprocess must never turn this into an
      // unbounded wait (order "nothing hangs"). `call()` has already resolved or
      // rejected by this point either way.
      void engine.stop().catch(() => {});
    }
  }
}

/** `codex` stays unimplemented (Aaron, 2026-09-04 16:40: astra is limited to what
 *  absolutely matters). No subprocess, no network call, no side effect of any kind. */
export class CodexReasoner implements Reasoner {
  readonly provider: Provider = 'codex';

  async call(_input: { className: string; prompt: string }): Promise<{ text: string }> {
    throw new Error(
      'the codex provider is not configured: astra is reachable only through '
      + 'dev-harness/tools/codex_call.py, never through this seam',
    );
  }
}

/** The one place a `Reasoner` gets built for a given provider, so `forge reason` and
 *  every production wiring site (`cli.ts`'s `forge up`) share one construction rather
 *  than each guessing which class to instantiate. */
export function reasonerFor(provider: Provider, deps: ClaudeReasonerDeps): Reasoner {
  return provider === 'codex' ? new CodexReasoner() : new ClaudeReasoner(deps);
}

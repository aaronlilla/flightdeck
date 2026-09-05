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

/** The preferred JSON shape a `claude` reasoner call is asked to answer with. There is
 *  no caller-supplied schema today: every seam that calls `Reasoner.call` reads a plain
 *  `text` back (`conformance-drift.ts`, `router.ts`), so this is the shape the
 *  `Reasoner` contract itself already commits to via its `Promise<{ text: string }>`
 *  return type. It is a preference, not the only shape accepted: I17 found a live reply
 *  that answered the question correctly as a well-formed JSON object in a different
 *  shape (`{"ok": true, "word": "surge"}`), and a reasoner that rejects a correct answer
 *  for missing a `text` key is a worse failure than one that accepts it and derives
 *  `text` from the whole object. */
const REPLY_SCHEMA = z.object({ text: z.string() });

/** A parsed reply that the caller can use: `parsed.data.text` if the object has a
 *  string `text` field, otherwise the whole object re-stringified so nothing the model
 *  said is silently dropped. Returns `undefined` for anything that is not a plain JSON
 *  object (an array, a bare string, a number, `null`) -- those still count as a parse
 *  failure, because there is no reasonable `text` to derive from them. */
function textFromReply(parsedJson: unknown): string | undefined {
  const direct = REPLY_SCHEMA.safeParse(parsedJson);
  if (direct.success) return direct.data.text;
  const isPlainObject = typeof parsedJson === 'object' && parsedJson !== null && !Array.isArray(parsedJson);
  return isPlainObject ? JSON.stringify(parsedJson) : undefined;
}

/** I17's acceptance: the model's raw reply is always kept in the journal row, parsed or
 *  not, so a wrong-shape-but-correct answer (or any other parse escape) is diagnosable
 *  from the journal alone instead of needing a repro. Capped at 2,000 characters -- a
 *  reasoning reply is a short verdict, not a transcript, and the journal is not the
 *  place for an unbounded blob. */
const RAW_MAX_CHARS = 2000;
function truncatedRaw(text: string): string {
  return text.length > RAW_MAX_CHARS ? text.slice(0, RAW_MAX_CHARS) : text;
}

/** Strips one leading and trailing markdown code fence (```json, ```JSON, plain ```,
 *  etc.) when the fence wraps the *entire* trimmed reply, and only then. Anchored at
 *  both ends on purpose (I19's falsifier): a fence that does not span the whole reply
 *  is left alone rather than stripped by a regex loose enough to eat real content, such
 *  as a code block quoted inside a finding's own claim text. */
const FENCE_RE = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/;

function stripFence(raw: string): string {
  const match = FENCE_RE.exec(raw);
  return match ? (match[1] ?? raw) : raw;
}

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

  async call(
    input: { className: string; prompt: string; replyShape?: 'object' | 'array' },
  ): Promise<{ text: string }> {
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
            const trimmed = text.trim();
            let parsedJson: unknown;
            try {
              parsedJson = JSON.parse(stripFence(trimmed));
            } catch {
              reject(new ReasonerParseError(text));
              return;
            }
            if (Array.isArray(parsedJson)) {
              // I19: a lens's whole reply is a findings array by its own prompt
              // (`reasonerRoles.ts`'s `buildLensPrompt`), fenced or not, so a caller
              // that declared `replyShape: 'array'` gets it back as-is (re-stringified,
              // for its own JSON.parse downstream) instead of a rejection for never
              // having arrived wrapped in `{"text": ...}`. Every other class keeps the
              // original fail-closed behavior: an array reply it never asked for is
              // still not a plain object, so it still cannot supply a `text`.
              if (input.replyShape === 'array') {
                resolve({ text: JSON.stringify(parsedJson) });
              } else {
                reject(new ReasonerParseError(text));
              }
              break;
            }
            const replyText = textFromReply(parsedJson);
            if (replyText === undefined) {
              reject(new ReasonerParseError(text));
              return;
            }
            resolve({ text: replyText });
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
      systemPrompt: SYSTEM_INSTRUCTIONS,
      env,
      canUseTool: async () => ({
        behavior: 'deny', message: 'the reasoner uses no tools',
      }) as never,
    });
    engine.send(prompt);

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
        durationMs: now() - startedAt, parsed: true, raw: truncatedRaw(text),
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
          parsed: false, raw: truncatedRaw(error.raw),
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

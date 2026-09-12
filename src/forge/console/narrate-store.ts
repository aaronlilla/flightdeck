/**
 * The narration cache and the queue behind it.
 *
 * The contract the whole layer rests on: `Narrator.get` is synchronous and always
 * answers. A hit returns the narrated registers; a miss returns the server's own template
 * with `narratedAt: null` and puts the key on a background queue. Nothing on a read route
 * ever waits for a model. When a narration lands, the store writes it to disk and
 * publishes the surface's slice event, and the console refetches that slice the way it
 * does for any other change.
 *
 * What is deliberately not here: a retry. A call that came back wrong is written as a
 * rejection and served as the template forever after, until the facts themselves change
 * and make a different key (`escalation: never-by-retry`). Paying twice for the same
 * wrong answer is the failure this design is built to refuse.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { Narrated, NarrationFacts } from '../../shared/console-model.js';
import type { SliceName } from '../../shared/console-events.js';
import type { Reasoner } from '../contracts.js';
import type { Journal } from '../journal.js';
import { forgeHome } from '../paths.js';
import { classFor, maxCallsPerHourFor, modelFor } from '../policy.js';

import {
  buildNarrationPrompt, narratedFrom, narrationKey, parseNarration, rawFor, templateNarration,
} from './narrate.js';
import { checkNarration, protectedTokensFor, type NarrationVerdict } from './narrate-checker.js';

/** One entry on disk. `input` is kept whole so a restart can re-check an entry against
 *  the facts it was written for without the caller having to hand them back. */
export interface NarrationEntry {
  key: string;
  input: NarrationFacts;
  glance: string;
  detail: string;
  narratedAt: number;
  model: string;
  verdict: NarrationVerdict;
  /** The call never came back: a dropped session, a timeout, an account limit, a reply
   *  that was not a narration. Held so the same key is not re-bought on the very next
   *  poll, and dropped on restart, because what failed was the trip and not the facts. */
  transport?: true;
}

const HOUR_MS = 3_600_000;

/**
 * How many narrations the cache keeps.
 *
 * There was no ceiling: one file per distinct fact record, kept for good, and `load()`
 * reads every one of them at boot. The policy's own 300 calls an hour is a quarter of a
 * million files a month, and the fleet this runs on is unattended. Twenty thousand is
 * roughly three days of the cap and far more than a console shows in a session; past it
 * the oldest go, because the sentences worth keeping are the ones on a board right now.
 * (Found 2026-09-09 by a critique of this file.)
 */
export const CACHE_MAX_ENTRIES = 20_000;

/** The disk half: one JSON file per key under `<FORGE_HOME>/narration`, written tmp then
 *  renamed so a half-written file is never read, and indexed in memory at construction. */
export class NarrationStore {
  private readonly dir: string;
  private readonly index = new Map<string, NarrationEntry>();
  private readonly max: number;

  /** `max` exists so a specimen can prove the eviction without writing twenty thousand
   *  files; nothing in the server passes it. */
  constructor(home: string = forgeHome(), max: number = CACHE_MAX_ENTRIES) {
    this.dir = join(home, 'narration');
    this.max = max;
    mkdirSync(this.dir, { recursive: true });
    this.load();
  }

  /** Re-reads the whole directory. A file that will not parse is skipped rather than
   *  thrown on: one corrupt entry must not take the board down, and the key it names is
   *  simply narrated again. */
  load(): void {
    this.index.clear();
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as NarrationEntry;
        if (!entry || typeof entry.key !== 'string') continue;
        // A transport failure is forgotten here on purpose. Inside one process it stands,
        // so a model that is down or an account past its limit cannot be re-bought by
        // every board every few seconds; across a restart it is gone, so a whole fleet's
        // sentences are not frozen on their templates for good by one bad ten minutes.
        if (entry.transport) continue;
        this.index.set(entry.key, entry);
      } catch {
        // skipped on purpose, see above
      }
    }
    this.evict();
  }

  /** Drops the oldest entries, on disk and in the index, until the cache is inside its
   *  ceiling. `narratedAt` orders them; an entry without one is treated as the oldest
   *  there is, because it is a record this version did not write. */
  private evict(): void {
    // A tenth of the ceiling is swept at once rather than one entry per write: a sort per
    // `put` at the ceiling would be the console's slowest path forever after.
    if (this.index.size <= this.max) return;
    const target = Math.max(0, this.max - Math.ceil(this.max / 10));
    const byAge = [...this.index.values()]
      .sort((a, b) => (a.narratedAt ?? 0) - (b.narratedAt ?? 0));
    const doomed = byAge.slice(0, this.index.size - target);
    for (const entry of doomed) {
      this.index.delete(entry.key);
      try {
        unlinkSync(join(this.dir, `${entry.key}.json`));
      } catch {
        // Already gone, or held open by another reader. The index no longer names it and
        // the next boot will not either; a file left behind costs a byte count, not a fact.
      }
    }
  }

  get(key: string): NarrationEntry | undefined {
    return this.index.get(key);
  }

  has(key: string): boolean {
    return this.index.has(key);
  }

  size(): number {
    return this.index.size;
  }

  put(entry: NarrationEntry): void {
    this.index.set(entry.key, entry);
    const final = join(this.dir, `${entry.key}.json`);
    // The tmp name carries this process and one random word. It was `${final}.tmp` flat,
    // and a FORGE_HOME has more than one writer -- the console server and
    // `scripts/narrate-proof.ts` run against the same home on purpose -- so two writers of
    // one key could interleave a write and a rename and publish half a file under a name
    // the next boot trusts. (Found 2026-09-09 by a critique of this file.)
    const tmp = `${final}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry, null, 2), 'utf8');
    renameSync(tmp, final);
    this.evict();
  }
}

export interface NarratorDeps {
  /** Always a real `Reasoner` built by `reasonerFor`, never a stand-in for the narrator
   *  itself: a test injects its `queryFn`, the same seam the reasoner's own suite uses. */
  reasoner: Reasoner;
  journal: Pick<Journal, 'append'>;
  /** Publishes the surface's slice event when a narration lands. */
  publish?: (slice: SliceName, reason: string, ref?: string) => void;
  home?: string;
  now?: () => number;
  /** Concurrency of the background queue. Two by default: enough that one slow call does
   *  not stall the board, low enough that a cold cache cannot storm the model. */
  concurrency?: number;
  policyPath?: string;
}

/** What a caller asks for: the facts, plus which slice to refetch once the text lands. */
export interface NarrationRequest extends NarrationFacts {
  slice?: SliceName;
  ref?: string;
}

const CLASS_NAME = 'narrate';

/**
 * The narrator. One per server.
 */
export class Narrator {
  private readonly store: NarrationStore;
  private readonly queue: NarrationRequest[] = [];
  private readonly pending = new Set<string>();
  /** One hour of reservations per surface, never one shared bucket -- a storm on one
   *  surface (a lane whose tool tally never quantised right) must not spend the whole
   *  fleet's hour and cap every other surface's genuine narrations along with it. */
  private readonly callTimesBySurface = new Map<string, number[]>();
  /** Where the hour of calls is kept between processes. See `loadCallTimes`. */
  private readonly callsPath: string;
  private running = 0;
  private readonly lastCappedRowAtBySurface = new Map<string, number>();
  /** Throttle for the dedup-visibility row (`narration.deduped`): once per surface per
   *  hour, the same reasoning as the cap row above -- a row per poll would be the same
   *  storm this fix removes, just moved into the journal instead of the model bill. */
  private readonly lastDedupedRowAtBySurface = new Map<string, number>();
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly deps: NarratorDeps) {
    this.store = new NarrationStore(deps.home);
    this.callsPath = join(deps.home ?? forgeHome(), 'narration-calls.json');
    this.loadCallTimes();
  }

  /**
   * The hour of calls, read back from disk.
   *
   * `maxCallsPerHour` is spend control, and it lived in this array alone -- so every
   * restart handed the fleet a fresh 300. A flightdeck cutover restarts the console, and
   * the console is the thing nobody is watching. The file is written beside the cache and
   * holds nothing but timestamps; a file that will not parse is an empty hour, which is
   * the same position this code was in before it existed. (Found 2026-09-09 by a critique
   * of this file.)
   */
  private loadCallTimes(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.callsPath, 'utf8')) as unknown;
      const at = this.now();
      // The old shape was a flat array, one hour for the whole class. A file written by
      // that version is read as the `_all` surface's own hour rather than discarded, so
      // upgrading mid-fleet does not hand every surface a fresh cap the same minute.
      const bySurface: Record<string, unknown> = Array.isArray(parsed)
        ? { _all: parsed }
        : (parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {});
      for (const [surface, values] of Object.entries(bySurface)) {
        if (!Array.isArray(values)) continue;
        const kept = values.filter((value): value is number => (
          typeof value === 'number' && at - value < HOUR_MS
        )).sort((a, b) => a - b);
        if (kept.length) this.callTimesBySurface.set(surface, kept);
      }
    } catch {
      // No file, or an unreadable one: an empty hour.
    }
  }

  /** Written on every reservation, so a process that dies mid-hour still spent it. */
  private saveCallTimes(): void {
    try {
      const tmp = `${this.callsPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      const bySurface: Record<string, number[]> = {};
      for (const [surface, values] of this.callTimesBySurface) bySurface[surface] = values;
      writeFileSync(tmp, JSON.stringify(bySurface), 'utf8');
      renameSync(tmp, this.callsPath);
    } catch {
      // A home that cannot be written is not a reason to stop answering reads. The cap
      // then holds for this process only, which is where it started.
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** `FORGE_NARRATE=off` disables the model entirely: templates everywhere, the cache
   *  untouched and still served, not a single call made. */
  private enabled(): boolean {
    if ((process.env['FORGE_NARRATE'] ?? '').toLowerCase() === 'off') return false;
    // A policy file that declares no `narrate` class is a fleet that has not bought the
    // narration layer. That is a configuration, not a fault: every surface serves its own
    // template in all three registers and nothing is queued, rather than one dead call
    // and one journal row per key.
    try {
      classFor(CLASS_NAME, this.deps.policyPath);
    } catch {
      return false;
    }
    return true;
  }

  /** Whether a call may be reserved now, counting reservations rather than completions:
   *  a cap enforced only once calls come back is no cap at all when a cold board asks for
   *  a thousand sentences at once. Cache hits are never counted -- they cost nothing. */
  private reserveCall(surface: string): boolean {
    const cap = maxCallsPerHourFor(CLASS_NAME, this.deps.policyPath);
    const at = this.now();
    const times = this.callTimesBySurface.get(surface) ?? [];
    while (times.length && at - (times[0] ?? 0) >= HOUR_MS) times.shift();
    if (cap !== null && times.length >= cap) {
      this.callTimesBySurface.set(surface, times);
      const lastRow = this.lastCappedRowAtBySurface.get(surface) ?? 0;
      if (at - lastRow >= HOUR_MS) {
        this.lastCappedRowAtBySurface.set(surface, at);
        this.deps.journal.append({
          event: 'narration.capped', actor: 'narrator', class: CLASS_NAME, surface,
          maxCallsPerHour: cap, servedTemplate: true,
        });
      }
      return false;
    }
    times.push(at);
    this.callTimesBySurface.set(surface, times);
    this.saveCallTimes();
    return true;
  }

  /**
   * The one read path. Answers immediately, every time.
   */
  get(input: NarrationRequest): Narrated {
    const key = narrationKey(input);
    const entry = this.store.get(key);
    if (entry) {
      if (entry.verdict.ok) {
        // The key is quantised (`narrationKey`), so a hit here can still carry a
        // different raw template than the one just asked for -- a counter or a clock
        // moved and the shape did not. That is the call this fix buys back; without a
        // row for it the saving is invisible; the drift is checked before the cheap
        // key-equality path below (a byte-identical repoll caused the same drift and
        // reduces `entry.input.template` to a no-op comparison against itself, so no
        // separate skip on that path).
        if (entry.input.template !== input.template
          || (entry.input.detailTemplate ?? '') !== (input.detailTemplate ?? '')) {
          this.journalDeduped(input.surface);
        }
        return narratedFrom(input, entry.glance, entry.detail, entry.narratedAt);
      }
      // A rejected narration is served as the template and never called again.
      return templateNarration(input);
    }
    this.enqueue(key, input);
    return templateNarration(input);
  }

  /** Once per surface per hour: the same throttle reasoning as `narration.capped`, so
   *  the visibility row itself never becomes the storm it is reporting on. */
  private journalDeduped(surface: string): void {
    const at = this.now();
    const lastRow = this.lastDedupedRowAtBySurface.get(surface) ?? 0;
    if (at - lastRow < HOUR_MS) return;
    this.lastDedupedRowAtBySurface.set(surface, at);
    this.deps.journal.append({
      event: 'narration.deduped', actor: 'narrator', class: CLASS_NAME, surface,
      reason: 'a counter or a clock changed but the sentence shape did not; served the cached narration',
    });
  }

  private enqueue(key: string, input: NarrationRequest): void {
    if (!this.enabled()) return;
    if (this.pending.has(key)) return;
    if (!this.reserveCall(input.surface)) return;
    this.pending.add(key);
    this.queue.push(input);
    this.pump();
  }

  private pump(): void {
    const limit = this.deps.concurrency ?? 2;
    while (this.running < limit && this.queue.length) {
      const next = this.queue.shift();
      if (!next) break;
      this.running += 1;
      void this.work(next).finally(() => {
        this.running -= 1;
        if (this.queue.length) this.pump();
        else if (this.running === 0) this.settle();
      });
    }
  }

  private settle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Resolves when the queue is empty and nothing is in flight. For tests and for a
   *  script that wants to know the first pass finished; the server never awaits it. */
  idle(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => { this.idleWaiters.push(resolve); });
  }

  private async work(input: NarrationRequest): Promise<void> {
    const key = narrationKey(input);
    // Inside the try on purpose: a throw out here is an unhandled rejection, because
    // nothing awaits `work`.
    let model = CLASS_NAME;
    try {
      model = modelFor(CLASS_NAME, this.deps.policyPath);
      const prompt = buildNarrationPrompt(input, protectedTokensFor(input));
      const reply = await this.deps.reasoner.call({ className: CLASS_NAME, prompt });
      const parsed = parseNarration(reply.text);
      const verdict: NarrationVerdict = parsed
        ? checkNarration(input, parsed)
        : {
          ok: false, token: null, register: null, rule: 'empty',
          reason: 'the reply was not a narration object',
        };
      this.store.put({
        key,
        input: { surface: input.surface, facts: input.facts, template: input.template, ...(input.detailTemplate ? { detailTemplate: input.detailTemplate } : {}) },
        glance: parsed?.glance ?? input.template,
        detail: parsed?.detail ?? (input.detailTemplate ?? input.template),
        narratedAt: this.now(),
        model,
        verdict,
      });
      if (!verdict.ok) {
        this.deps.journal.append({
          event: 'narration.rejected', actor: 'narrator', class: CLASS_NAME,
          surface: input.surface, rule: verdict.rule, token: verdict.token,
          register: verdict.register, reason: verdict.reason,
        });
      }
      if (input.slice) {
        this.deps.publish?.(input.slice, `narration landed for ${input.surface}`, input.ref);
      }
    } catch (error) {
      // A failed call is journaled by the reasoner itself (`reasoner.call` with
      // `parsed: false`, or `reasoner.timeout`) and again here by surface. The entry is
      // cached as a refusal, not left unknown: an unknown key is re-queued by the very
      // next poll, so a model that is down for a minute buys a fresh call from every
      // board in the fleet every few seconds, which is the one failure mode a narration
      // layer must not have (`escalation: never-by-retry`).
      //
      // Freezing the sentence at its template is safe because the key is the fact record.
      // The moment anything about the lane moves -- a check lands, the state changes, the
      // queue shifts -- the facts differ, the key differs, and a new call is made. Only a
      // record that never changes again keeps its template, and a row nothing will ever
      // touch again is exactly the row worth the least.
      const reason = error instanceof Error ? error.message : String(error);
      this.store.put({
        key,
        input: { surface: input.surface, facts: input.facts, template: input.template, ...(input.detailTemplate ? { detailTemplate: input.detailTemplate } : {}) },
        glance: input.template,
        detail: input.detailTemplate ?? input.template,
        narratedAt: this.now(),
        model,
        verdict: {
          ok: false, token: null, register: null, rule: 'empty',
          reason: `the call did not complete: ${reason}`,
        },
        transport: true,
      });
      this.deps.journal.append({
        event: 'narration.failed', actor: 'narrator', class: CLASS_NAME,
        surface: input.surface, error: reason, cachedTemplate: true,
      });
    } finally {
      this.pending.delete(key);
    }
  }

  /** The `raw` register on its own, for a route answering `?verbose=1` without asking
   *  for a narration at all. */
  raw(input: NarrationFacts): string {
    return rawFor(input);
  }

  /** How many entries the cache holds, for the proof script and the tests. */
  cacheSize(): number {
    return this.store.size();
  }

  /** Re-reads the directory, the way a restarted server does. */
  reload(): void {
    this.store.load();
  }
}

/**
 * Person-authored text: an operator's own words, an agent's reply, the question a run
 * wrote, a PR title, a brief heading. It is never narrated, never cached and never sent
 * to a model -- the three registers are the same string, and `narratedAt` stays null
 * because nothing narrated it.
 */
export function passThrough(text: string): Narrated {
  return { glance: text, detail: text, raw: text, narratedAt: null };
}

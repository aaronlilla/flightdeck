/**
 * A trap, written down the moment somebody hits it.
 *
 * Self-heal is live rather than nightly (Aaron, 2026-09-04), and the timing is the whole
 * value. A trap recorded a week later is archaeology: the next agent has already lost the
 * afternoon to it. So the worker that hits one files it and carries on. It does not wait
 * for a classification, does not decide whether the trap is worth keeping, and does not
 * stop to write the fix.
 *
 * Four fields are required, because a gotcha missing any of them cannot be acted on:
 * what happened, the command or path, the verbatim error, and what would have prevented
 * it. The last one is what separates a fix from a complaint.
 *
 * What may then be changed automatically is deliberately narrow. Notes, skills, briefs
 * and Forge's own non-guard code go to a fix lane that opens a draft pull request. Guards
 * and the model policy wait for Aaron, and so does anything the classifier cannot place:
 * a path nobody declared is not evidence that changing it is safe.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendOnce } from './journal.js';

export interface GotchaInput {
  run: string;
  /** What happened, in one sentence a person can act on. */
  what: string;
  /** The command that was run or the path that was touched. */
  where: string;
  /** The error, verbatim. Paraphrasing it is what makes it unsearchable. */
  error: string;
  /** What would have prevented it. The field that turns this into a fix. */
  prevention: string;
  ticket?: string;
}

export interface Gotcha extends GotchaInput {
  id: string;
  at: number;
  hits: number;
  runs: string[];
  lane: 'fix' | 'aaron';
  why: string;
  /** The filing worker keeps working. Always. */
  disposition: 'carry-on';
}

/**
 * Paths a fix subagent may never touch on its own.
 *
 * A guard that can be edited by the thing it guards is not a guard. The model policy is
 * on the same list for the same reason: it is the file that decides what everything costs,
 * and an automated change to it is an automated change to the budget.
 */
const AARON_ONLY = [
  /(^|[\\/])hooks[\\/][A-Za-z0-9_]*\.py$/i,
  /_guard\.py$/i,
  /model-policy\.json$/i,
  /(^|[\\/])settings(\.portable)?\.json$/i,
  /install\.ps1$/i,
];

/** Paths a fix subagent may change by draft pull request. */
const FIXABLE = [
  /\.mdx?$/i,
  /(^|[\\/])skills[\\/]/i,
  /(^|[\\/])src[\\/]forge[\\/].*\.ts$/i,
  /(^|[\\/])tests[\\/]/i,
];

export interface Classification {
  lane: 'fix' | 'aaron';
  why: string;
}

/**
 * Which lane a gotcha's fix belongs in.
 *
 * Order matters: the Aaron list is checked first, so a `.json` under `hooks/` is held
 * even though the fixable list would otherwise take it. Anything unmatched is held too,
 * because "the classifier had no opinion" is not the same as "this is safe to change".
 */
export function classifyGotcha(input: Pick<GotchaInput, 'where'>): Classification {
  const where = input.where ?? '';
  for (const pattern of AARON_ONLY) {
    if (pattern.test(where)) {
      return { lane: 'aaron', why: 'guards and the model policy are changed by Aaron, not by the fleet' };
    }
  }
  for (const pattern of FIXABLE) {
    if (pattern.test(where)) {
      return { lane: 'fix', why: 'notes, skills, briefs and Forge\'s own code go by draft pull request' };
    }
  }
  return { lane: 'aaron', why: `nothing declares ${where}, and unplaced is not the same as safe` };
}

/** The identity of a trap: the same wall hit twice is one gotcha with two hits. */
function gotchaId(input: GotchaInput): string {
  const normalise = (text: string) => (text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256')
    .update(`${normalise(input.where)}|${normalise(input.error)}`)
    .digest('hex').slice(0, 16);
}

export class Gotchas {
  constructor(private readonly dir: string, private readonly journalPath: string) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  get(id: string): Gotcha | undefined {
    const path = this.pathFor(id);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Gotcha;
    } catch {
      return undefined;
    }
  }

  all(): Gotcha[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.get(name.slice(0, -'.json'.length)))
      .filter((found): found is Gotcha => Boolean(found))
      .sort((a, b) => a.at - b.at);
  }

  /**
   * Record a trap.
   *
   * Throws on a record missing a required field, and that is the one place this is strict:
   * a gotcha with no verbatim error or no prevention costs a reader more than it gives
   * them, and accepting it quietly fills the registry with things nobody can act on.
   */
  file(input: GotchaInput): Gotcha {
    for (const field of ['what', 'where', 'error', 'prevention'] as const) {
      if (!(input[field] ?? '').trim()) {
        throw new Error(
          `a gotcha needs ${field}: what happened, the command or path, the verbatim error, `
          + 'and what would have prevented it. Without all four nobody can act on it.',
        );
      }
    }

    const id = gotchaId(input);
    const existing = this.get(id);
    const { lane, why } = classifyGotcha(input);

    const gotcha: Gotcha = existing
      ? {
        ...existing,
        hits: existing.hits + 1,
        runs: existing.runs.includes(input.run) ? existing.runs : [...existing.runs, input.run],
      }
      : {
        ...input, id, at: Date.now(), hits: 1, runs: [input.run], lane, why,
        disposition: 'carry-on',
      };

    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.pathFor(id), JSON.stringify(gotcha, null, 2), 'utf8');
    appendOnce(this.journalPath, {
      event: 'gotcha',
      run: input.run,
      actor: 'worker',
      gotcha: id,
      lane: gotcha.lane,
      where: input.where,
    });
    return gotcha;
  }
}

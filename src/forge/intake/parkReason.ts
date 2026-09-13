/**
 * What a parked card says.
 *
 * A run ends with a verdict -- one token, written for a switch statement. The park used
 * that token as the sentence a person reads, so a ticket that relaunched three times and
 * was handed over with "a person needs to read this one" offered exactly one word to
 * read: `stopped` (Aaron, 2026-09-13, on the live board).
 *
 * The verdict still decides what happened. This decides how it is said, and the hop is
 * part of it: stopping before the work is written means something different from
 * stopping after a pull request exists, and the same word covered both.
 */

/** Every verdict a run can end on. Enumerated so a test can walk all of them, and so a
 *  verdict added without a sentence here fails that test rather than reaching a card as
 *  a bare word. */
export const PARK_VERDICTS = [
  'stopped', 'dead', 'killed', 'exhausted', 'budget-cap', 'model-mismatch',
  'unavailable', 'unverified', 'unknown', 'parked', 'done', 'on-brief',
  'blocked', 'off-brief', 'failed',
] as const;

export type ParkHop = 'plan' | 'run' | 'gate' | string;

/** What the hop means in a sentence: where the run had got to when it stopped. */
function atTheHop(hop: ParkHop): string {
  if (hop === 'plan') return 'before it had a plan';
  if (hop === 'run') return 'while it was working';
  if (hop === 'gate') return 'after the work, on the way to a pull request';
  return `at the ${hop} step`;
}

const SENTENCE: Partial<Record<string, (hop: ParkHop) => string>> = {
  stopped: (hop) => `It stopped ${atTheHop(hop)} without saying why. Re-check it, or start it again.`,
  dead: (hop) => `Its process is gone ${atTheHop(hop)}. Nothing is running for it now.`,
  killed: (hop) => `Somebody stopped it ${atTheHop(hop)}.`,
  exhausted: (hop) => `It ran out of room to think ${atTheHop(hop)}. Compact it and start it again.`,
  'budget-cap': (hop) => `It hit the spending cap ${atTheHop(hop)}. Raise the cap or leave it here.`,
  'model-mismatch': (hop) => `It was running on the wrong model ${atTheHop(hop)}.`,
  unavailable: (hop) => `Its account could not be reached ${atTheHop(hop)}.`,
  unverified: (hop) => `It finished ${atTheHop(hop)} with nothing proving the work is good.`,
  unknown: (hop) => `It ended ${atTheHop(hop)} and left no verdict at all.`,
  parked: (hop) => `It parked itself ${atTheHop(hop)}.`,
  done: (hop) => `It reported finished ${atTheHop(hop)}, with nothing to show for it.`,
  'on-brief': (hop) => `It reported the work on brief ${atTheHop(hop)}, with nothing to show for it.`,
  blocked: (hop) => `It hit something it could not get past ${atTheHop(hop)}.`,
  // The machine's own word for work that wandered. Said in the words the rest of the
  // console already uses for it, so one screen does not speak differently from another.
  'off-brief': (hop) => `It went off the brief ${atTheHop(hop)}.`,
  failed: (hop) => `It failed ${atTheHop(hop)}.`,
};

/**
 * The sentence a parked item carries.
 *
 * A reason that is already a sentence is returned untouched: several park sites write a
 * real explanation and wrapping those would say the same thing twice. Only a bare token
 * -- a single word, which is what a verdict is -- gets turned into words.
 */
export function parkReasonFor(reason: string | null | undefined, hop: ParkHop): string {
  const text = (reason ?? '').trim();
  if (!text) return SENTENCE['unknown']!(hop);
  // More than one word is somebody's own sentence; leave it alone.
  if (/\s/.test(text)) return text;
  const known = SENTENCE[text];
  if (known) return known(hop);
  // A verdict nobody has written a line for. Say the word rather than hide it, inside a
  // sentence that still tells a reader where it happened.
  return `It ended ${atTheHop(hop)} with "${text}", which this console has no words for yet.`;
}

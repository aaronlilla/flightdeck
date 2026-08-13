/**
 * Shape of the specimen corpus.
 *
 * The corpus is the part of the old Python harness worth carrying across. The
 * guards themselves are being rewritten, but every deliberately broken payload
 * their suites fired at them is evidence that took real incidents to collect,
 * and standing order 2 says a rewritten guard counts only once it has been
 * watched failing on these.
 *
 * Positive specimens must trip the guard. Controls must not. A guard that
 * fires on everything is worth as little as one that fires on nothing, so the
 * corpus carries both and the runner fails on either kind of miss.
 */
export interface Specimen<TInput, TVerdict> {
  /** What this case is testing, in the words a person would use. */
  name: string;
  input: TInput;
  expect: TVerdict;
  /** Substring the guard's message must contain, when the verdict is not a pass. */
  reasonIncludes?: string;
  /** Why this case exists, when that is not obvious from the name. */
  why?: string;
}

/** What a guard can conclude. Mirrors GuardDecision without the payloads. */
export type Verdict = 'deny' | 'annotate' | 'pass';

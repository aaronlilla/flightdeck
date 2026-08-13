/**
 * Convergence specimens, ported from the Python suite.
 *
 * Standing order 15: a conclusion is survived, not reached. A plan has to name
 * a rival account, state what would prove it wrong, and list its unknowns.
 *
 * The interesting half of this corpus is the plans that satisfy the rule
 * without using its vocabulary. A plan that argues in flowing prose has done
 * the thinking, and a guard that only recognises headings would teach the
 * author to write headings instead of to think.
 */
import type { Specimen, Verdict } from './types.ts';

/** Padding so a plan counts as substantial rather than short. */
const FILLER = Array.from(
  { length: 45 },
  (_, i) => `Step ${i + 1}: do the next part of the work and check the result.`,
).join('\n');

export const ALTERNATIVES = `## Alternatives rejected

I considered a queue-backed retry and rejected it: it drags a broker into the
system for the sake of one endpoint, and the operational cost outweighs the
reliability it buys. I also considered exponential backoff in the caller, which
spreads the same policy across nine call sites and makes it impossible to change
in one place later.
`;

export const FALSIFIER_LONG = `## Falsifier

This is wrong if the endpoint turns out to be non-idempotent, which would make
any retry unsafe rather than merely slow.
`;

export const FALSIFIER_SHORT = `## Falsifier

This is wrong if the Stop hook mostly false-positives.
`;

export const UNKNOWNS = `## Unknowns

I have not verified the upstream timeout, and I am assuming the 502s are
transient rather than a persistent capacity problem. The retry budget is a
guess until someone measures the real failure rate.
`;

const plan = (...parts: string[]) => `# Plan\n\n${parts.join('\n')}\n${FILLER}\n`;

export const NONE_OF_THREE = plan(
  '## Design\n\nBuild the thing.\n\n## Order of work\n\n1. Write it.\n2. Ship it.\n',
);

export const EMPTY_HEADINGS = plan('## Alternatives rejected\n\n## Falsifier\n\n## Unknowns\n');

export const COMPLETE = plan(ALTERNATIVES, FALSIFIER_LONG, UNKNOWNS);

export const NO_FALSIFIER = plan(ALTERNATIVES, UNKNOWNS);

export const PROSE_COMPLETE = `# Retry the flaky endpoint

I considered two other approaches and rejected both: a queue-backed retry, which
drags in a broker for one endpoint, and exponential backoff in the caller, which
spreads the policy across nine call sites and leaves no single place to change it.

The change adds a bounded retry with jitter inside the fetch helper, so every
caller inherits it without knowing about it.

This is wrong if the endpoint turns out to be non-idempotent, which would make
any retry unsafe rather than merely slow, and I would abandon this if the
upstream team confirms writes are replayed.

Unknowns: I have not verified the upstream timeout, and I am assuming the 502s
are transient rather than a persistent capacity problem. Nobody has measured the
real failure rate, so the retry budget is a guess.
${FILLER}
`;

export const SHORT_BARE = `# Fix the typo

Change \`recieve\` to \`receive\` in the login error string.
`;

export const SHORT_COMPLETE = `${SHORT_BARE}\n${ALTERNATIVES}\n${FALSIFIER_SHORT}\n${UNKNOWNS}`;

export const ONE_SENTENCE_FALSIFIER = plan(ALTERNATIVES, FALSIFIER_SHORT, UNKNOWNS);

export const CONVERGENCE_SPECIMENS: Array<Specimen<string, Verdict>> = [
  // --- must object ---------------------------------------------------------
  {
    name: 'plan with none of the three requirements',
    input: NONE_OF_THREE,
    expect: 'deny',
  },
  {
    name: 'plan with the right headings and nothing under them',
    input: EMPTY_HEADINGS,
    expect: 'deny',
    why: 'Headings are cheap. The rule is about substance, so empty sections fail.',
  },
  {
    name: 'plan missing only the falsifier',
    input: NO_FALSIFIER,
    expect: 'deny',
    reasonIncludes: 'falsifier',
  },

  // --- must pass -----------------------------------------------------------
  {
    name: 'plan carrying all three requirements',
    input: COMPLETE,
    expect: 'pass',
  },
  {
    name: 'plan that argues in prose with no headings at all',
    input: PROSE_COMPLETE,
    expect: 'pass',
    why: 'The rule is about the thinking, not about the formatting.',
  },
  {
    name: 'one sentence falsifier clears the bar',
    input: ONE_SENTENCE_FALSIFIER,
    expect: 'pass',
    why: 'A falsifier is one sentence by design. Its floor is lower than the others.',
  },
  {
    name: 'short bare plan gets advice rather than refusal',
    input: SHORT_BARE,
    expect: 'annotate',
    reasonIncludes: 'short',
    why: 'Proportionality is doctrine. A typo fix does not owe a full drill.',
  },
  {
    name: 'short plan that is complete anyway',
    input: SHORT_COMPLETE,
    expect: 'pass',
  },
];

/**
 * Humanizer rule specimens. No corpus existed anywhere in flightdeck before this stream
 * (`2026-09-04-forge-council.md` decision 2), so this one is derived straight from the
 * `humanizer` skill's own rule list (`doctrine/skills/humanizer/SKILL.md`), one specimen
 * per rule this rule mechanically checks: em dashes (rule 14, a hard constraint against
 * a reliable AI tell), overused AI vocabulary (rule 7), negative parallelism (rule 9),
 * and boldface overuse (rule 15). The skill's other rules (inflated significance,
 * elegant variation, false ranges, rule-of-three, ...) need judgment a regex cannot
 * apply reliably and are out of scope for this mechanical rule; see the goal brief's
 * Status section for that gap named explicitly.
 */
import type { Specimen } from './gitflow.ts';

export const HUMANIZER_SPECIMENS: Specimen[] = [
  {
    name: 'em dash in a PR body',
    input: { kind: 'pr', op: 'create', repo: 'flightdeck', title: 'x', body: 'The new policy — announced without warning — affects everyone.', cwd: '/repos/sample-app' },
    expect: 'deny',
    reasonIncludes: 'em dash',
  },
  {
    name: 'double-hyphen em dash stand-in in a commit message',
    input: { kind: 'commit', message: 'fix retry -- the old backoff never reset', cwd: '/repos/sample-app' },
    expect: 'deny',
    reasonIncludes: 'em dash',
  },
  {
    name: 'overused AI vocabulary in a reply',
    input: { kind: 'reply', text: 'This is a pivotal change that underscores the crucial role of retries.' },
    expect: 'deny',
    reasonIncludes: 'vocabulary',
  },
  {
    name: 'negative parallelism in a file edit',
    input: { kind: 'edit', path: 'docs/notes.md', text: "It's not just about the retry, it's about the whole pipeline." },
    expect: 'deny',
    reasonIncludes: 'negative parallelism',
  },
  {
    name: 'boldface overuse in a PR body',
    input: { kind: 'pr', op: 'create', repo: 'flightdeck', title: 'x', body: 'Uses **OKRs**, **KPIs**, and **BSC** together.', cwd: '/repos/sample-app' },
    expect: 'deny',
    reasonIncludes: 'boldface',
  },
  {
    name: 'control: plain PR body, no em dash, no AI vocabulary',
    input: { kind: 'pr', op: 'create', repo: 'flightdeck', title: 'x', body: 'Fixes the retry loop so a dropped connection backs off once instead of every tick.', cwd: '/repos/sample-app' },
    expect: 'allow',
  },
  {
    name: 'control: a hyphenated word is not a double-hyphen em dash',
    input: { kind: 'commit', message: 'fix: off-by-one in the retry counter', cwd: '/repos/sample-app' },
    expect: 'allow',
  },
  {
    name: 'control: one bold term used for a real reason',
    input: { kind: 'edit', path: 'docs/notes.md', text: 'Set **DEBUG** to true before running the reproduction.' },
    expect: 'allow',
  },
  {
    name: 'control: ordinary reply with no flagged pattern',
    input: { kind: 'reply', text: 'The test at line 88 covers this path already.' },
    expect: 'allow',
  },
];

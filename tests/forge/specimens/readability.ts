/**
 * Readability rule specimens (order 19). Covers both callers: the structured `'pr'`
 * action Council's merge gate builds (`cli.ts`), and the raw `'bash'` action the
 * worker's own PreToolUse hook sees when it issues `gh pr create`/`comment`/`edit`
 * itself -- the PR-creation path G4 named, since nothing in this codebase opens a PR
 * any other way.
 *
 * The contract and repo names here are the neutral in-repo set
 * (`tests/forge/specimens/readability/contract.json`), never the real one -- see
 * `tests/setup.ts`, which points `FORGE_READABILITY_DIR` at it for every test file.
 */
import type { ProposedAction } from '../../../src/forge/rules/types.ts';
import type { Specimen } from './gitflow.ts';

const CWD = '/repos/acme-app';

const CONFORMING_BODY = [
  '## What breaks',
  '',
  'A doubled webhook credits twice.',
  '',
  '## What changes',
  '',
  'The second one is ignored.',
  '',
  '### src/webhooks/claim.ts:24',
  '',
  '```ts',
  'if (!await claims.tryClaim(transferId)) return ok();',
  '```',
  '',
  '## How to run',
  '',
  '```',
  'npm test',
  '```',
].join('\n');

const SECTIONLESS_BODY = 'Fixed the webhook double-credit bug, should be good to merge now.';

export const READABILITY_SPECIMENS: Specimen[] = [
  {
    name: 'gh pr create with no required sections, on an outward repo',
    input: {
      kind: 'bash',
      command: `gh pr create --repo acme/acme-app --title "ACME-73 webhook claim" --body "${SECTIONLESS_BODY}"`,
      cwd: CWD,
    } satisfies ProposedAction,
    expect: 'deny',
    reasonIncludes: 'missing required section',
  },
  {
    name: 'gh pr create fully conforming, on an outward repo',
    input: {
      kind: 'bash',
      command: `gh pr create --repo acme/acme-app --title "ACME-73 webhook claim" --body "${CONFORMING_BODY}"`,
      cwd: CWD,
    } satisfies ProposedAction,
    expect: 'allow',
  },
  {
    name: 'gh pr create with no ticket key in the title, on a ticket-key repo',
    input: {
      kind: 'bash',
      command: `gh pr create --repo acme/acme-app --title "webhook claim fix" --body "${CONFORMING_BODY}"`,
      cwd: CWD,
    } satisfies ProposedAction,
    expect: 'deny',
    reasonIncludes: 'ticket key',
  },
  {
    name: 'gh pr comment over the 80-word ceiling, on an outward repo',
    input: {
      kind: 'bash',
      command: `gh pr comment 71 --repo acme/acme-app --body "${Array.from({ length: 90 }, (_v, i) => `word${i}`).join(' ')}"`,
      cwd: CWD,
    } satisfies ProposedAction,
    expect: 'deny',
    reasonIncludes: '80',
  },
  {
    name: 'gh pr comment under the ceiling',
    input: {
      kind: 'bash',
      command: 'gh pr comment 71 --repo acme/acme-app --body "Checks are green, ready for review."',
      cwd: CWD,
    } satisfies ProposedAction,
    expect: 'allow',
  },
  {
    name: 'control: gh pr create on a non-outward repo is out of scope',
    input: {
      kind: 'bash',
      command: `gh pr create --repo acme/internal-tools --title "no ticket key here" --body "${SECTIONLESS_BODY}"`,
      cwd: '/repos/internal-tools',
    } satisfies ProposedAction,
    expect: 'allow',
  },
  {
    name: 'control: an unrelated bash command is untouched',
    input: { kind: 'bash', command: 'git status', cwd: CWD } satisfies ProposedAction,
    expect: 'allow',
  },
  {
    name: "Council's merge gate: structured 'pr' action missing required sections",
    input: {
      kind: 'pr', op: 'merge', repo: 'acme-app', title: 'ACME-73 webhook claim',
      body: SECTIONLESS_BODY, cwd: CWD,
    } satisfies ProposedAction,
    expect: 'deny',
    reasonIncludes: 'missing required section',
  },
  {
    name: "Council's merge gate: structured 'pr' action fully conforming",
    input: {
      kind: 'pr', op: 'merge', repo: 'acme-app', title: 'ACME-73 webhook claim',
      body: CONFORMING_BODY, cwd: CWD,
    } satisfies ProposedAction,
    expect: 'allow',
  },
  {
    // G3 (readability-total, 2026-09-10): repo arrives as an owner/name slug in every
    // real caller (gh --repo, cli.ts's merge gate, queue.ts's routed item.repo), never
    // as the contract's bare name -- the mismatch made the whole gate a no-op.
    name: "Council's merge gate: 'pr' action with an owner/name repo slug still gates",
    input: {
      kind: 'pr', op: 'comment', repo: 'acme/acme-app', title: '',
      body: Array.from({ length: 90 }, (_v, i) => `word${i}`).join(' '), cwd: CWD,
    } satisfies ProposedAction,
    expect: 'deny',
    reasonIncludes: '80',
  },
];

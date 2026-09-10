/**
 * Readability rule specimens (order 19). Covers both callers: the structured `'pr'`
 * action Council's merge gate builds (`cli.ts`), and the raw `'bash'` action the
 * worker's own PreToolUse hook sees when it issues `gh pr create`/`comment`/`edit`
 * itself -- the PR-creation path G4 named, since nothing in this codebase opens a PR
 * any other way.
 */
import type { ProposedAction } from '../../../src/forge/rules/types.ts';
import type { Specimen } from './gitflow.ts';

const CWD = '/repos/BBManagementSystemV2';

const CONFORMING_BODY = [
  '## What breaks',
  '',
  'A doubled webhook credits twice.',
  '',
  '## What changes',
  '',
  'The second one is ignored.',
  '',
  '### BoltBetz.ManagementSystem/Sila/SilaWebhookClaim.cs:24',
  '',
  '```csharp',
  'if (!await claims.TryClaimAsync(transferId)) return Ok();',
  '```',
  '',
  '## How to run',
  '',
  '```',
  'dotnet test',
  '```',
].join('\n');

const SECTIONLESS_BODY = 'Fixed the webhook double-credit bug, should be good to merge now.';

export const READABILITY_SPECIMENS: Specimen[] = [
  {
    name: 'gh pr create with no required sections, on an outward repo',
    input: {
      kind: 'bash',
      command: `gh pr create --repo boltbetz/BBManagementSystemV2 --title "BBZ-73 webhook claim" --body "${SECTIONLESS_BODY}"`,
      cwd: CWD,
    } satisfies ProposedAction,
    expect: 'deny',
    reasonIncludes: 'missing required section',
  },
  {
    name: 'gh pr create fully conforming, on an outward repo',
    input: {
      kind: 'bash',
      command: `gh pr create --repo boltbetz/BBManagementSystemV2 --title "BBZ-73 webhook claim" --body "${CONFORMING_BODY}"`,
      cwd: CWD,
    } satisfies ProposedAction,
    expect: 'allow',
  },
  {
    name: 'gh pr create with no ticket key in the title, on a ticket-key repo',
    input: {
      kind: 'bash',
      command: `gh pr create --repo boltbetz/BBManagementSystemV2 --title "webhook claim fix" --body "${CONFORMING_BODY}"`,
      cwd: CWD,
    } satisfies ProposedAction,
    expect: 'deny',
    reasonIncludes: 'ticket key',
  },
  {
    name: 'gh pr comment over the 80-word ceiling, on an outward repo',
    input: {
      kind: 'bash',
      command: `gh pr comment 71 --repo boltbetz/BBManagementSystemV2 --body "${Array.from({ length: 90 }, (_v, i) => `word${i}`).join(' ')}"`,
      cwd: CWD,
    } satisfies ProposedAction,
    expect: 'deny',
    reasonIncludes: '80',
  },
  {
    name: 'gh pr comment under the ceiling',
    input: {
      kind: 'bash',
      command: 'gh pr comment 71 --repo boltbetz/BBManagementSystemV2 --body "Checks are green, ready for review."',
      cwd: CWD,
    } satisfies ProposedAction,
    expect: 'allow',
  },
  {
    name: 'control: gh pr create on flightdeck itself is out of scope',
    input: {
      kind: 'bash',
      command: `gh pr create --repo boltbetz/flightdeck --title "no ticket key here" --body "${SECTIONLESS_BODY}"`,
      cwd: '/repos/flightdeck',
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
      kind: 'pr', op: 'merge', repo: 'bbmanagementsystemv2', title: 'BBZ-73 webhook claim',
      body: SECTIONLESS_BODY, cwd: CWD,
    } satisfies ProposedAction,
    expect: 'deny',
    reasonIncludes: 'missing required section',
  },
  {
    name: "Council's merge gate: structured 'pr' action fully conforming",
    input: {
      kind: 'pr', op: 'merge', repo: 'bbmanagementsystemv2', title: 'BBZ-73 webhook claim',
      body: CONFORMING_BODY, cwd: CWD,
    } satisfies ProposedAction,
    expect: 'allow',
  },
  {
    // G3 (readability-total, 2026-09-10): repo arrives as an owner/name slug in every
    // real caller (gh --repo, cli.ts's merge gate, queue.ts's routed item.repo), never
    // as OUTWARD_REPOS's bare name -- the mismatch made the whole gate a no-op.
    name: "Council's merge gate: 'pr' action with an owner/name repo slug still gates",
    input: {
      kind: 'pr', op: 'comment', repo: 'boltbetz/BBManagementSystemV2', title: '',
      body: Array.from({ length: 90 }, (_v, i) => `word${i}`).join(' '), cwd: CWD,
    } satisfies ProposedAction,
    expect: 'deny',
    reasonIncludes: '80',
  },
];

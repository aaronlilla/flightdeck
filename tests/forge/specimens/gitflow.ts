import type { ProposedAction } from '../../../src/forge/rules/types.ts';

export interface Specimen {
  name: string;
  input: ProposedAction;
  expect: 'allow' | 'deny';
  reasonIncludes?: string;
}

const CONTROLLED_CWD = '/repos/controlled-service';
const AUTONOMOUS_CWD = '/repos/autonomous-app';

/**
 * Ported from ~/.claude/hooks/gitflow_guard.py, scoped to what Council's merge gate
 * actually needs: a controlled-code repo (flagged by the caller, never by a hardcoded
 * repo name -- see types.ts) denies a state-changing git/gh action landing on
 * develop/main/master. Everywhere else this rule stays out of the way; the merge gate
 * itself, not this rule, is what keeps an autonomous repo's PR from merging when a
 * different gate condition fails.
 */
export const GITFLOW_SPECIMENS: Specimen[] = [
  {
    name: 'git push to develop in a controlled repo is denied',
    input: { kind: 'bash', command: 'git push origin develop', cwd: CONTROLLED_CWD, controlled: true },
    expect: 'deny',
    reasonIncludes: 'controlled-code',
  },
  {
    name: 'git push to a feature branch in a controlled repo is allowed',
    input: { kind: 'bash', command: 'git push origin feature/thing', cwd: CONTROLLED_CWD, controlled: true },
    expect: 'allow',
  },
  {
    name: 'gh pr merge against a controlled repo is denied',
    input: { kind: 'pr', op: 'merge', base: 'develop', repo: 'controlled-service', cwd: CONTROLLED_CWD, controlled: true },
    expect: 'deny',
    reasonIncludes: 'controlled-code',
  },
  {
    name: 'gh pr create against a controlled repo is allowed (open, never merge)',
    input: { kind: 'pr', op: 'create', base: 'develop', repo: 'controlled-service', cwd: CONTROLLED_CWD, controlled: true },
    expect: 'allow',
  },
  {
    name: 'a commit while HEAD is on develop in a controlled repo is denied',
    input: { kind: 'commit', message: 'wip', cwd: CONTROLLED_CWD, controlled: true, branch: 'develop' },
    expect: 'deny',
    reasonIncludes: 'controlled-code',
  },
  {
    name: 'a commit while HEAD is on a feature branch in a controlled repo is allowed',
    input: { kind: 'commit', message: 'wip', cwd: CONTROLLED_CWD, controlled: true, branch: 'feature/thing' },
    expect: 'allow',
  },
  {
    name: 'gh pr merge against an autonomous repo is allowed (this rule stays out of the way)',
    input: { kind: 'pr', op: 'merge', base: 'develop', repo: 'autonomous-app', cwd: AUTONOMOUS_CWD, controlled: false },
    expect: 'allow',
  },
  {
    name: 'git push to develop in an autonomous repo is allowed',
    input: { kind: 'bash', command: 'git push origin develop', cwd: AUTONOMOUS_CWD, controlled: false },
    expect: 'allow',
  },
  {
    name: 'a read-only git command in a controlled repo is allowed',
    input: { kind: 'bash', command: 'git status', cwd: CONTROLLED_CWD, controlled: true },
    expect: 'allow',
  },
];

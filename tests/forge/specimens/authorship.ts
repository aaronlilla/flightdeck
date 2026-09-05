/**
 * Authorship rule specimens, adapted from tests/specimens/authorship.ts to
 * `ProposedAction`. Same detection, different action shape: Council's gate checks a
 * commit message, a PR title/body, a diff hunk, or a reply, not an SDK tool call.
 *
 * Every banned string is assembled from fragments at run time so this file does not
 * become a violation of the rule it specimens.
 */
import type { ProposedAction } from '../../../src/forge/rules/types.ts';
import type { Specimen } from './gitflow.ts';

const j = (...parts: string[]) => parts.join('');

const TRAILER = j('Co-Authored', '-By', ': Claude Opus 5 <no', 'reply@anthropic', '.com>');
const ROBOT = '\u{1F916}';
const ROBOT_SIGNOFF = j(ROBOT, ' Generated ', 'with [Claude', ' Code](https://claude', '.com/claude-code)');
const CREDIT_PR_BODY = j('This PR was ', 'generated ', 'by an AI ', 'agent.');
const CREDIT_NOTE = j('This note was ', 'written ', 'by Claude.');

const CWD = '/repos/sample-app';

export const AUTHORSHIP_SPECIMENS: Specimen[] = [
  {
    name: 'commit message carrying an AI co-author trailer',
    input: { kind: 'commit', message: `fix: null deref\n\n${TRAILER}`, cwd: CWD },
    expect: 'deny',
    reasonIncludes: 'authorship',
  },
  {
    name: 'PR body with the robot sign-off',
    input: { kind: 'pr', op: 'create', repo: 'flightdeck', title: 'x', body: `Adds retry.\n\n${ROBOT_SIGNOFF}`, cwd: CWD },
    expect: 'deny',
  },
  {
    name: 'PR body claiming an AI agent wrote it',
    input: { kind: 'pr', op: 'create', repo: 'flightdeck', title: 'x', body: CREDIT_PR_BODY, cwd: CWD },
    expect: 'deny',
  },
  {
    name: 'a reply carrying the trailer',
    input: { kind: 'reply', text: `Done. ${TRAILER}` },
    expect: 'deny',
  },
  {
    name: 'a file edit crediting Claude, outside any exempt path',
    input: { kind: 'edit', path: 'docs/internal-notes/n.md', text: CREDIT_NOTE },
    expect: 'deny',
  },
  {
    name: 'control: ordinary commit message',
    input: { kind: 'commit', message: 'fix: null deref in baseQuery', cwd: CWD },
    expect: 'allow',
  },
  {
    name: 'control: CLAUDE.md quoting the trailer it forbids',
    input: { kind: 'edit', path: 'CLAUDE.md', text: `Commits used to end with:\n\n${TRAILER}\n` },
    expect: 'allow',
  },
  {
    name: 'control: PR body stating Claude Code is a tool the team uses',
    input: { kind: 'pr', op: 'create', repo: 'flightdeck', title: 'x', body: 'Claude Code is a CLI tool the team uses for reviews.', cwd: CWD },
    expect: 'allow',
  },
  {
    name: 'control: human co-author',
    input: { kind: 'commit', message: `fix: x\n\n${j('Co-Authored', '-By', ': Joe Buckley <joe@example.com>')}`, cwd: CWD },
    expect: 'allow',
  },
];

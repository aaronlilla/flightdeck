/**
 * Authorship specimens, ported from the Python suite.
 *
 * Standing order 13: Aaron is the sole author of everything that ships. The
 * hard part is not spotting a co-author trailer, it is staying quiet across the
 * many legitimate ways a repository talks about Claude, so most of this file is
 * controls.
 *
 * Every banned string is assembled from fragments at run time. Written as
 * literals they would make this file an authorship violation in its own right,
 * and the alternative fix, exempting the path, puts a hole exactly where the
 * detector is supposed to be. Same reasoning as the contamination check.
 */
import type { ToolCall } from '../../src/types.ts';
import type { Specimen, Verdict } from './types.ts';

const j = (...parts: string[]) => parts.join('');

export const ROBOT = '\u{1F916}';

/** The trailer standing order 13 exists to stop. */
export const TRAILER = j('Co-Authored', '-By', ': Claude Opus 5 <no', 'reply@anthropic', '.com>');

/** The sign-off the harness defaults would otherwise append to a PR body. */
export const ROBOT_SIGNOFF = j(
  ROBOT,
  ' Generated ',
  'with [Claude',
  ' Code](https://claude',
  '.com/claude-code)',
);

const CREDIT_README = j('This module was ', 'generated ', 'by an AI ', 'agent.');
const CREDIT_COMMENT = j('// ', 'implemented ', 'by Claude');
const CREDIT_NOTE = j('This note was ', 'written ', 'by Claude.');
const CREDIT_LABEL = j('release: ', 'ai-', 'assisted refactor');

const bash = (command: string): ToolCall => ({ toolName: 'Bash', input: { command } });
const write = (file_path: string, content: string): ToolCall => ({
  toolName: 'Write',
  input: { file_path, content },
});
const edit = (file_path: string, new_string: string): ToolCall => ({
  toolName: 'Edit',
  input: { file_path, new_string },
});

export const AUTHORSHIP_SPECIMENS: Array<Specimen<ToolCall, Verdict>> = [
  // --- must deny -----------------------------------------------------------
  {
    name: 'commit carrying an AI co-author trailer',
    input: bash(`git commit -m "fix: null deref\n\n${TRAILER}"`),
    expect: 'deny',
    reasonIncludes: 'co-author',
  },
  {
    name: 'pull request body with the robot sign-off',
    input: bash(`gh pr create --title "x" --body "Adds retry.\n\n${ROBOT_SIGNOFF}"`),
    expect: 'deny',
  },
  {
    name: 'readme claiming an AI wrote it',
    input: write('README.md', `# App\n\n${CREDIT_README}\n`),
    expect: 'deny',
  },
  {
    name: 'source comment crediting Claude',
    input: write('src/x.ts', `${CREDIT_COMMENT}\nconst a = 1;\n`),
    expect: 'deny',
  },
  {
    name: 'changelog edit carrying the trailer',
    input: edit('CHANGELOG.md', `## 1.2.0\n\n${TRAILER}\n`),
    expect: 'deny',
  },
  {
    name: 'note claiming Claude wrote it, outside any exempt path',
    input: write('docs/internal-notes/n.md', CREDIT_NOTE),
    expect: 'deny',
  },
  {
    name: 'tag message with an assisted-by-AI label',
    input: bash(`git tag -a v1.2.0 -m "${CREDIT_LABEL}"`),
    expect: 'deny',
  },

  // --- must not deny -------------------------------------------------------
  {
    name: 'control: ordinary commit message',
    input: bash('git commit -m "fix: null deref in baseQuery"'),
    expect: 'pass',
    why: 'A clean publish is the common case and must never be interrupted.',
  },
  {
    name: 'control: doctrine file quoting the trailer it forbids',
    input: write('CLAUDE.md', `Commits used to end with:\n\n${TRAILER}\n`),
    expect: 'pass',
    why: 'Exempt path. The rules have to be able to quote what they ban.',
  },
  {
    name: 'control: readme stating Claude Code is a tool the team uses',
    input: write('README.md', '# Tooling\n\nClaude Code is a CLI tool the team uses for reviews.\n'),
    expect: 'pass',
    why: 'A fact about a product is not a claim of authorship.',
  },
  {
    name: 'control: unrelated shell command',
    input: bash('ls -la'),
    expect: 'pass',
  },
  {
    name: 'control: grepping for the trailer rather than writing one',
    input: bash(`grep -r "${TRAILER}" .git/COMMIT_EDITMSG`),
    expect: 'pass',
    why: 'Reading is not publishing. Only publish commands are scanned.',
  },
  {
    name: 'control: memory file carrying the trailer',
    input: write('.claude/projects/x/memory/x.md', TRAILER),
    expect: 'pass',
    why: 'Exempt path.',
  },
  {
    name: 'control: human co-author',
    input: bash(`git commit -m "fix: x\n\n${j('Co-Authored', '-By', ': Joe Buckley <joe@example.com>')}"`),
    expect: 'pass',
    why: 'Co-authorship by a person is fine. Only AI attribution is banned.',
  },
  {
    name: 'control: contributor whose name is Ai',
    input: bash(`git commit -m "fix: x\n\n${j('Co-Authored', '-By', ': Ai Nguyen <ai@example.com>')}"`),
    expect: 'pass',
    why: 'A real person named Ai must not be mistaken for a tool.',
  },
  {
    name: 'control: prose discussing machine-written text',
    input: write('notes.md', 'The reviewer checks whether a PR body reads as machine written.\n'),
    expect: 'pass',
    why: 'Discussing detection is not claiming authorship.',
  },
  {
    name: 'control: code with no prose at all',
    input: write('src/x.ts', 'const a = 1;\nexport default a;\n'),
    expect: 'pass',
  },
];

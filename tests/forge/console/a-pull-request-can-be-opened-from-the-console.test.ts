import { describe, expect, it, vi } from 'vitest';

import { openPullRequest, type OpenPrDeps } from '../../../src/forge/console/open-pr.js';

/**
 * Opening a pull request from the console.
 *
 * Aaron, 2026-09-13: the whole board should be driveable from the console's own screens.
 * Opening a pull request was one of four actions that existed nowhere on one -- the only
 * `gh pr create` in the codebase runs inside a worker's own turn (`sdkengine.ts`), so a
 * branch a worker pushed and then stopped short of could only be turned into a pull
 * request from a terminal.
 *
 * The refusals are the point. Every one of them is a thing that would otherwise be
 * discovered by GitHub rejecting the call, or worse by Joe reading a body that breaks the
 * rule he asked for. Each says which of them it is, by name, and opens nothing.
 */
function deps(over: Partial<OpenPrDeps> = {}): OpenPrDeps {
  return {
    lane: () => ({ repo: 'owner/repo', branch: 'feature/abc-1', base: 'develop', ticket: 'ABC-1' }),
    pushed: vi.fn(async () => true),
    existing: vi.fn(async () => null),
    create: vi.fn(async () => ({ ok: true as const, number: 7, url: 'https://github.com/x/y/pull/7' })),
    readability: () => ({ verdict: 'SILENT' as const, reason: '' }),
    ...over,
  };
}

describe('opening a pull request from the console', () => {
  it('opens it, and answers with the number and the link', async () => {
    const d = deps();
    const result = await openPullRequest('run-1', 'ABC-1 fix the thing', 'What breaks\n\nIt did not.', d);

    expect(result.ok).toBe(true);
    expect(result.number).toBe(7);
    expect(result.url).toBe('https://github.com/x/y/pull/7');
    expect(result.refused).toBe('');
  });

  it('opens it as a draft when asked, and says so', async () => {
    const d = deps();
    await openPullRequest('run-1', 'ABC-1 fix', 'What breaks\n\nIt did not.', d, { draft: true });

    expect((d.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ draft: true });
  });

  // A branch with no commits on the remote cannot have a pull request. GitHub's own
  // refusal for this names neither the branch nor what to do, so it is caught here.
  it('refuses an unpushed branch, naming it, and never calls create', async () => {
    const d = deps({ pushed: vi.fn(async () => false) });
    const result = await openPullRequest('run-1', 'ABC-1 fix', 'What breaks\n\nIt did not.', d);

    expect(result.ok).toBe(false);
    expect(result.refused).toMatch(/feature\/abc-1/);
    expect(result.refused).toMatch(/push/i);
    expect((d.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  // Pressing twice must not be how somebody finds out one already exists, and the second
  // press has to hand over the first one's link rather than an error.
  it('refuses when a pull request is already open on that branch, and links it', async () => {
    const d = deps({ existing: vi.fn(async () => ({ number: 3, url: 'https://github.com/x/y/pull/3' })) });
    const result = await openPullRequest('run-1', 'ABC-1 fix', 'What breaks\n\nIt did not.', d);

    expect(result.ok).toBe(false);
    expect(result.refused).toMatch(/already/i);
    expect(result.url).toBe('https://github.com/x/y/pull/3');
    expect(result.number).toBe(3);
    expect((d.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  // The rule Joe asked for. A body that breaks it is refused HERE, before the request
  // exists -- not opened, rejected by the guard, and left sitting there for him to read.
  it('refuses a body the readability rule denies, quoting the reason, and opens nothing', async () => {
    const d = deps({
      readability: () => ({ verdict: 'DENY' as const, reason: 'no ticket key in the title' }),
    });
    const result = await openPullRequest('run-1', 'fix the thing', 'What breaks\n\nIt did not.', d);

    expect(result.ok).toBe(false);
    expect(result.refused).toMatch(/no ticket key in the title/);
    expect((d.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  // ADVISE is not DENY. The rule advises below a line and denies above it, and treating
  // the two alike here would refuse work the rule deliberately lets through.
  it('opens it when the rule only advises, and carries the advice back', async () => {
    const d = deps({
      readability: () => ({ verdict: 'ADVISE' as const, reason: '168 words against a 150-word target' }),
    });
    const result = await openPullRequest('run-1', 'ABC-1 fix', 'What breaks\n\nIt did not.', d);

    expect(result.ok).toBe(true);
    expect(result.advice).toMatch(/150-word target/);
    expect((d.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('refuses a lane with no branch on record rather than guessing one', async () => {
    const d = deps({ lane: () => ({ repo: 'owner/repo', branch: null, base: 'develop', ticket: 'ABC-1' }) });
    const result = await openPullRequest('run-1', 'ABC-1 fix', 'What breaks\n\nIt did not.', d);

    expect(result.ok).toBe(false);
    expect(result.refused).toMatch(/branch/i);
    expect((d.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('refuses a lane it does not know at all', async () => {
    const d = deps({ lane: () => null });
    const result = await openPullRequest('nope', 'ABC-1 fix', 'What breaks\n\nIt did not.', d);

    expect(result.ok).toBe(false);
    expect(result.refused).toMatch(/nope/);
  });

  it('refuses an empty title or body rather than opening a blank request', async () => {
    expect((await openPullRequest('run-1', '   ', 'body', deps())).refused).toMatch(/title/i);
    expect((await openPullRequest('run-1', 'ABC-1 fix', '  ', deps())).refused).toMatch(/body|describ/i);
  });

  // `gh` failing is not the same as the request being wrong, and the operator needs the
  // real message rather than a verdict.
  it('carries a failure from gh back verbatim rather than reporting success', async () => {
    const d = deps({
      create: vi.fn(async () => ({ ok: false as const, error: 'GraphQL: No commits between develop and feature/abc-1' })),
    });
    const result = await openPullRequest('run-1', 'ABC-1 fix', 'What breaks\n\nIt did not.', d);

    expect(result.ok).toBe(false);
    expect(result.refused).toMatch(/No commits between/);
  });

  // The same lesson the handoff route learned from a thrown fetch: a rejection must not
  // escape and leave the caller with no answer at all.
  it('never rejects, whatever gh does', async () => {
    const d = deps({ create: vi.fn(async () => { throw new Error('gh: command not found'); }) });
    const result = await openPullRequest('run-1', 'ABC-1 fix', 'What breaks\n\nIt did not.', d);

    expect(result.ok).toBe(false);
    expect(result.refused).toMatch(/command not found/);
  });
});

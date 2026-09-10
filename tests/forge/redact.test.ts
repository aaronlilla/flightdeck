import { describe, expect, it } from 'vitest';

import { redact } from '../../src/forge/redact.js';

describe('redact', () => {
  it('replaces a long token-shaped run with a placeholder', () => {
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    expect(redact(`auth failed for token ${secret}`)).not.toContain(secret);
    expect(redact(`auth failed for token ${secret}`)).toContain('[REDACTED]');
  });

  it('leaves ordinary short words and prose alone', () => {
    expect(redact('npm install failed: ENOENT no such file')).toBe('npm install failed: ENOENT no such file');
  });

  it('is a no-op on empty input', () => {
    expect(redact('')).toBe('');
  });

  it('never masks a git sha, even a token-shaped secret alongside it in the same text', () => {
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f90123abcd'; // 40 hex chars
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const text = `checks are pending on head ${sha}, token was ${secret}`;
    const out = redact(text);
    expect(out).toContain(sha);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
  });

  it('leaves a short 7-char abbreviated sha alone (below the pattern floor, never touched)', () => {
    expect(redact('head is at a1b2c3d')).toBe('head is at a1b2c3d');
  });
});

// `gh pr view --json` hands the council a JSON document whose string values carry
// `\n` as two characters. A long word right after one of those newlines, such as an
// env key in a fenced block of the PR body, used to be swallowed together with the
// `n` of the escape, leaving `\[REDACTED]`: not JSON, so the council refused a PR
// over the shape of its own body (mobile app repository, PR 148, 2026-09-10).
describe('redact keeps JSON escapes intact', () => {
  it('leaves a document parseable when a long word follows an escaped newline', () => {
    const doc = JSON.stringify({ body: 'SHOW_DEV_BADGE=\nBYPASS_EMAIL_VERIFICATION=\nALLOW_ENV_SWITCH=' });
    const scrubbed = redact(doc);
    expect(() => JSON.parse(scrubbed)).not.toThrow();
    expect(scrubbed).not.toContain('BYPASS_EMAIL_VERIFICATION');
    expect(JSON.parse(scrubbed).body).toContain('\n[REDACTED]=');
  });

  it('keeps a \\uXXXX escape whole when a long word follows it', () => {
    const doc = JSON.stringify({ body: '·ABCDEFGHIJKLMNOPQRSTUVWXYZ' }).replace('·', '\\u00b7');
    const scrubbed = redact(doc);
    expect(() => JSON.parse(scrubbed)).not.toThrow();
    expect(scrubbed).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });

  it('still scrubs a bare token and still keeps a git sha', () => {
    expect(redact('token ghp_abcdefghijklmnopqrstuvwxyz012345')).toBe('token [REDACTED]');
    const sha = '743c1b3a9e2f4c6d8b0a1e2f3c4d5e6f7a8b9c0d';
    expect(redact(sha)).toBe(sha);
  });
});

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

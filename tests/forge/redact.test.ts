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
});

import { describe, expect, it } from 'vitest';

import { maskCommandLine } from '../../../src/forge/machine/redact.js';

describe('maskCommandLine', () => {
  it('masks key=value and key:value shapes', () => {
    expect(maskCommandLine('node worker.js --token=abc123')).not.toContain('abc123');
    expect(maskCommandLine('node worker.js --token: abc123')).not.toContain('abc123');
  });

  it('masks a space-separated secret flag (no = or :)', () => {
    const masked = maskCommandLine('python worker.py --token abc123456789');
    expect(masked).not.toContain('abc123456789');
    expect(masked).toContain('[REDACTED]');
  });

  it('masks a bare-credential (token-as-username) URL with no password segment', () => {
    const masked = maskCommandLine('git clone https://ghp_abcdef0123456789@github.com/example-org/example-repo.git');
    expect(masked).not.toContain('ghp_abcdef0123456789');
    expect(masked).toContain('[REDACTED]@github.com');
  });

  it('masks a full user:pass@ credentialed URL', () => {
    const masked = maskCommandLine('python scrape.py https://user:hunter2@example.com/api');
    expect(masked).not.toContain('hunter2');
    expect(masked).not.toContain('user:hunter2');
  });

  it('masks a quoted key=value secret in full, not just up to the first space', () => {
    const masked = maskCommandLine('node worker.js --token="my secret value"');
    expect(masked).not.toContain('secret value');
    expect(masked).not.toContain('my secret');
  });

  it('masks the credential following a multi-part Authorization scheme', () => {
    const masked = maskCommandLine('curl -H "Authorization: Basic dXNlcjpwYXNzd29yZA=="');
    expect(masked).not.toContain('dXNlcjpwYXNzd29yZA==');
  });

  it('masks a bearer token', () => {
    const masked = maskCommandLine('curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret"');
    expect(masked).not.toContain('eyJhbGciOiJIUzI1NiJ9.secret');
  });

  it('masks an env-var-style credential name (underscore-joined)', () => {
    // /code-review high, 2026-09-10: `\b` treats `_` as a word char, so the old pattern
    // never matched "SECRET" inside "AWS_SECRET_ACCESS_KEY".
    const masked = maskCommandLine('node deploy.js AWS_SECRET_ACCESS_KEY=AKIAxxxxSECRETVALUE');
    expect(masked).not.toContain('AKIAxxxxSECRETVALUE');
    const maskedPassword = maskCommandLine('node deploy.js DB_PASSWORD=hunter2');
    expect(maskedPassword).not.toContain('hunter2');
  });

  it('leaves an ordinary command line with no credential shape untouched', () => {
    expect(maskCommandLine('node index.js --port=3000')).toBe('node index.js --port=3000');
  });
});

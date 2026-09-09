/**
 * Live limits for a linked account, read from the provider the way its own CLI does.
 * Everything here is pure or takes an injected `fetch`, so no specimen needs the network
 * and no specimen carries a real token -- the JWT below is a made-up base64url payload,
 * never a credential that works against anything.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseClaudeUsage, parseClaudeProfile, parseCodexUsage, readCodexAuth, probeClaude, probeCodex,
  type Fetch,
} from '../../src/forge/accounts-probe.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-probe-'));
});

afterEach(() => {
  // best-effort; vitest's tmp cleanup handles the rest
});

function jwt(payload: Record<string, unknown>): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${b64}.sig`;
}

const CLAUDE_LIMITS_BODY = JSON.stringify({
  limits: [
    { kind: 'session', group: 'session', percent: 30, severity: 'normal', resets_at: '2026-09-09T23:39:59Z', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 80, severity: 'warning', resets_at: '2026-09-15T12:59:59Z', scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 72, severity: 'normal', resets_at: '2026-09-15T12:59:59Z', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
  ],
});

const CODEX_USAGE_BODY = JSON.stringify({
  email: 'a@b.c',
  plan_type: 'pro',
  rate_limit: {
    primary_window: { used_percent: 72, limit_window_seconds: 604800, reset_after_seconds: 452930, reset_at: 1789435313 },
    secondary_window: { used_percent: 5, limit_window_seconds: 18000, reset_after_seconds: 100, reset_at: 1789000000 },
  },
});

describe('parseClaudeUsage', () => {
  it('reads the limits array into Session / Weekly / Weekly · Fable, with percent, reset ms, and severity', () => {
    const windows = parseClaudeUsage(CLAUDE_LIMITS_BODY);
    expect(windows).toEqual([
      { key: 'session', label: 'Session', usedPct: 30, resetsAt: Date.parse('2026-09-09T23:39:59Z'), severity: 'normal' },
      { key: 'weekly', label: 'Weekly', usedPct: 80, resetsAt: Date.parse('2026-09-15T12:59:59Z'), severity: 'warning' },
      { key: 'weekly:Fable', label: 'Weekly · Fable', usedPct: 72, resetsAt: Date.parse('2026-09-15T12:59:59Z'), severity: 'normal' },
    ]);
  });

  it('falls back to five_hour/seven_day when limits is absent', () => {
    const body = JSON.stringify({
      five_hour: { utilization: 45, resets_at: '2026-09-09T23:39:59Z' },
      seven_day: { utilization: 60, resets_at: '2026-09-15T12:59:59Z' },
    });
    const windows = parseClaudeUsage(body);
    expect(windows).toEqual([
      { key: 'session', label: 'Session', usedPct: 45, resetsAt: Date.parse('2026-09-09T23:39:59Z') },
      { key: 'weekly', label: 'Weekly', usedPct: 60, resetsAt: Date.parse('2026-09-15T12:59:59Z') },
    ]);
  });

  it('gives an empty array for a garbage body', () => {
    expect(parseClaudeUsage('not json at all')).toEqual([]);
    expect(parseClaudeUsage('{}')).toEqual([]);
  });
});

describe('parseClaudeProfile', () => {
  it('gives email and "max" for a Claude Max account', () => {
    const body = JSON.stringify({ account: { email: 'a@b.c', has_claude_max: true } });
    expect(parseClaudeProfile(body)).toEqual({ email: 'a@b.c', plan: 'max' });
  });

  it('gives nothing for garbage', () => {
    expect(parseClaudeProfile('not json')).toEqual({});
  });
});

describe('parseCodexUsage', () => {
  it('reads primary_window (604800s) as Weekly with reset_at seconds turned to ms, and secondary (18000s) as Session sorted first', () => {
    const reading = parseCodexUsage(CODEX_USAGE_BODY);
    expect(reading.email).toBe('a@b.c');
    expect(reading.plan).toBe('pro');
    expect(reading.windows).toEqual([
      { key: 'session', label: 'Session', usedPct: 5, resetsAt: 1789000000 * 1000 },
      { key: 'weekly', label: 'Weekly', usedPct: 72, resetsAt: 1789435313 * 1000 },
    ]);
  });
});

describe('readCodexAuth', () => {
  it('reads email, plan, and accountId from a temp auth.json', () => {
    const codexHome = join(dir, 'codex-home');
    mkdirSync(codexHome, { recursive: true });
    const idToken = jwt({ email: 'a@b.c', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } });
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({
      tokens: { access_token: 'tok-123', account_id: 'acct-1', id_token: idToken },
    }), 'utf8');

    const auth = readCodexAuth(codexHome);
    expect(auth).toEqual({ accessToken: 'tok-123', accountId: 'acct-1', email: 'a@b.c', plan: 'pro' });
  });

  it('is null with no auth.json file', () => {
    const codexHome = join(dir, 'codex-home-empty');
    mkdirSync(codexHome, { recursive: true });
    expect(readCodexAuth(codexHome)).toBeNull();
  });
});

describe('probeClaude', () => {
  it('sends the bearer token and anthropic-beta header, and merges the usage and profile bodies', async () => {
    const configDir = join(dir, 'claude-config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-abc' } }), 'utf8');

    const calls: { url: string; headers: Record<string, string> }[] = [];
    const profileBody = JSON.stringify({ account: { email: 'a@b.c', has_claude_max: true } });
    const fetchFn: Fetch = async (url, init) => {
      calls.push({ url, headers: init.headers });
      const text = url.includes('/oauth/profile') ? profileBody : CLAUDE_LIMITS_BODY;
      return { status: 200, text: async () => text };
    };

    const reading = await probeClaude(configDir, fetchFn);
    expect(reading.email).toBe('a@b.c');
    expect(reading.plan).toBe('max');
    expect(reading.windows).toHaveLength(3);

    for (const call of calls) {
      expect(call.headers['Authorization']).toBe('Bearer tok-abc');
      expect(call.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    }
    expect(calls.map((c) => c.url).sort()).toEqual([
      'https://api.anthropic.com/api/oauth/profile',
      'https://api.anthropic.com/api/oauth/usage',
    ]);
  });
});

describe('probeCodex', () => {
  it('sends the ChatGPT-Account-Id header', async () => {
    const codexHome = join(dir, 'codex-home-2');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({
      tokens: { access_token: 'tok-xyz', account_id: 'acct-9' },
    }), 'utf8');

    let seenHeaders: Record<string, string> = {};
    const fetchFn: Fetch = async (_url, init) => {
      seenHeaders = init.headers;
      return { status: 200, text: async () => CODEX_USAGE_BODY };
    };

    const reading = await probeCodex(codexHome, fetchFn);
    expect(reading.email).toBe('a@b.c');
    expect(seenHeaders['ChatGPT-Account-Id']).toBe('acct-9');
    expect(seenHeaders['Authorization']).toBe('Bearer tok-xyz');
  });

  it('a non-200 response rejects', async () => {
    const codexHome = join(dir, 'codex-home-3');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'tok-fail' } }), 'utf8');
    const fetchFn: Fetch = async () => ({ status: 401, text: async () => 'nope' });
    await expect(probeCodex(codexHome, fetchFn)).rejects.toThrow(/401/);
  });
});

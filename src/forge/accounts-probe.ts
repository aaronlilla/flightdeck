/**
 * Live limits for a linked account, read from the provider the way its own CLI does.
 *
 * Claude: the login under a config directory keeps an OAuth token in
 * `.credentials.json`; `api.anthropic.com/api/oauth/usage` answers with the five-hour and
 * seven-day windows as a used fraction and a reset time, and `/api/oauth/profile` with the
 * email and the plan. This is the same pair `claude /usage` reads.
 *
 * ChatGPT (Codex): the login under a Codex home keeps its tokens in `auth.json`; the
 * id token carries the email and plan, and `chatgpt.com/backend-api/wham/usage` answers
 * with the rate-limit windows. Same source as `codex /status`.
 *
 * Everything here is pure or takes an injected `fetch`, so a test can feed it a body and
 * a probe never needs the network to be proven.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Provider = 'claude' | 'codex';

export interface WindowReading {
  /** Stable key: `session`, `weekly`, `weekly:Fable`, `5_hour`, `7_day`. */
  key: string;
  /** What the row says: `Session`, `Weekly`, `Weekly · Fable`. */
  label: string;
  /** 0..100. */
  usedPct: number;
  /** Epoch ms, or null when the provider gave none. */
  resetsAt: number | null;
  /** Provider's own severity when it says one (`normal`, `warning`, `limited`). */
  severity?: string;
}

export interface UsageReading {
  email?: string;
  plan?: string;
  windows: WindowReading[];
}

export type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;

const FIVE_HOURS = 5 * 3600;
const SEVEN_DAYS = 7 * 86400;

function windowByLength(seconds: number): { key: string; label: string } {
  if (seconds === FIVE_HOURS) return { key: 'session', label: 'Session' };
  if (seconds === SEVEN_DAYS) return { key: 'weekly', label: 'Weekly' };
  if (seconds % 86400 === 0) return { key: `${seconds / 86400}_day`, label: `${seconds / 86400}-day` };
  const hours = Math.round(seconds / 3600);
  return { key: `${hours}_hour`, label: `${hours}-hour` };
}

function parseIso(value: unknown): number | null {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
}

// ---- Claude ----------------------------------------------------------------------

/** The OAuth access token a Claude login keeps under its config directory, or null. */
export function readClaudeToken(configDir: string): string | null {
  const path = join(configDir, '.credentials.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * The windows the account is measured on. The `limits` array is the source when the
 * endpoint sends one: every entry is a window (`session`, `weekly_all`, or a
 * `weekly_scoped` bucket naming a model such as Fable) with its percent and reset time.
 * The older `five_hour` / `seven_day` pair is read only when `limits` is absent.
 */
export function parseClaudeUsage(body: string): WindowReading[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return [];
  }
  const limits = parsed['limits'];
  if (Array.isArray(limits)) {
    const out: WindowReading[] = [];
    for (const raw of limits) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as { kind?: unknown; group?: unknown; percent?: unknown; resets_at?: unknown; severity?: unknown; scope?: { model?: { display_name?: unknown } } | null };
      if (typeof row.percent !== 'number' || typeof row.kind !== 'string') continue;
      const model = typeof row.scope?.model?.display_name === 'string' ? row.scope.model.display_name : null;
      const group = typeof row.group === 'string' ? row.group : row.kind;
      const base = group === 'session' ? { key: 'session', label: 'Session' }
        : group === 'weekly' ? { key: 'weekly', label: 'Weekly' }
          : { key: group, label: group.replace(/_/g, ' ') };
      out.push({
        key: model ? `${base.key}:${model}` : base.key,
        label: model ? `${base.label} · ${model}` : base.label,
        usedPct: clampPct(row.percent),
        resetsAt: parseIso(row.resets_at),
        ...(typeof row.severity === 'string' ? { severity: row.severity } : {}),
      });
    }
    if (out.length > 0) return out;
  }
  const out: WindowReading[] = [];
  for (const [key, seconds] of [['five_hour', FIVE_HOURS], ['seven_day', SEVEN_DAYS]] as const) {
    const row = parsed[key];
    if (!row || typeof row !== 'object') continue;
    const { utilization, resets_at: resetsAt } = row as { utilization?: unknown; resets_at?: unknown };
    if (typeof utilization !== 'number') continue;
    out.push({ ...windowByLength(seconds), usedPct: clampPct(utilization), resetsAt: parseIso(resetsAt) });
  }
  return out;
}

export function parseClaudeProfile(body: string): { email?: string; plan?: string } {
  try {
    const parsed = JSON.parse(body) as { account?: { email?: unknown; has_claude_max?: unknown; has_claude_pro?: unknown }; organization?: { organization_type?: unknown } };
    const email = typeof parsed.account?.email === 'string' ? parsed.account.email : undefined;
    const orgType = typeof parsed.organization?.organization_type === 'string' ? parsed.organization.organization_type : undefined;
    const plan = parsed.account?.has_claude_max === true ? 'max'
      : parsed.account?.has_claude_pro === true ? 'pro'
        : orgType ? orgType.replace(/^claude_/, '') : undefined;
    return { ...(email ? { email } : {}), ...(plan ? { plan } : {}) };
  } catch {
    return {};
  }
}

const CLAUDE_HEADERS = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  'anthropic-beta': 'oauth-2025-04-20',
  'User-Agent': 'flightdeck',
});

export async function probeClaude(configDir: string, fetchFn: Fetch): Promise<UsageReading> {
  const token = readClaudeToken(configDir);
  if (!token) throw new Error('no login under this config directory');
  const [usage, profile] = await Promise.all([
    fetchFn('https://api.anthropic.com/api/oauth/usage', { headers: CLAUDE_HEADERS(token) }),
    fetchFn('https://api.anthropic.com/api/oauth/profile', { headers: CLAUDE_HEADERS(token) }),
  ]);
  if (usage.status !== 200) throw new Error(`usage read failed: HTTP ${usage.status}`);
  const windows = parseClaudeUsage(await usage.text());
  const who = profile.status === 200 ? parseClaudeProfile(await profile.text()) : {};
  return { ...who, windows };
}

// ---- Codex / ChatGPT ---------------------------------------------------------------

export interface CodexAuth {
  accessToken: string;
  accountId?: string;
  email?: string;
  plan?: string;
}

function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The tokens a Codex login keeps in `auth.json` under its home, or null. */
export function readCodexAuth(codexHome: string): CodexAuth | null {
  const path = join(codexHome, 'auth.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { tokens?: { access_token?: unknown; id_token?: unknown; account_id?: unknown } };
    const accessToken = parsed.tokens?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) return null;
    const out: CodexAuth = { accessToken };
    if (typeof parsed.tokens?.account_id === 'string') out.accountId = parsed.tokens.account_id;
    const claims = typeof parsed.tokens?.id_token === 'string' ? jwtClaims(parsed.tokens.id_token) : null;
    if (claims) {
      if (typeof claims['email'] === 'string') out.email = claims['email'];
      const auth = claims['https://api.openai.com/auth'];
      const plan = auth && typeof auth === 'object' ? (auth as { chatgpt_plan_type?: unknown }).chatgpt_plan_type : undefined;
      if (typeof plan === 'string') out.plan = plan;
    }
    return out;
  } catch {
    return null;
  }
}

export function parseCodexUsage(body: string): UsageReading {
  let parsed: { email?: unknown; plan_type?: unknown; rate_limit?: RateLimit; additional_rate_limits?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { windows: [] };
  }
  const windows: WindowReading[] = codexWindows(parsed.rate_limit, null);
  // Model-scoped buckets (`additional_rate_limits`, one per named model) sit beside the
  // account-wide pair, the way Claude's scoped weekly bucket does.
  if (Array.isArray(parsed.additional_rate_limits)) {
    for (const extra of parsed.additional_rate_limits) {
      if (!extra || typeof extra !== 'object') continue;
      const { limit_name: name, rate_limit: limit } = extra as { limit_name?: unknown; rate_limit?: RateLimit };
      windows.push(...codexWindows(limit, typeof name === 'string' ? name : null));
    }
  }
  // Session before weekly, the order the Claude side reports.
  windows.sort((a, b) => (a.key === 'session' ? 0 : 1) - (b.key === 'session' ? 0 : 1));
  return {
    ...(typeof parsed.email === 'string' ? { email: parsed.email } : {}),
    ...(typeof parsed.plan_type === 'string' ? { plan: parsed.plan_type } : {}),
    windows,
  };
}

interface RateLimit { primary_window?: unknown; secondary_window?: unknown }

function codexWindows(limit: RateLimit | undefined, scope: string | null): WindowReading[] {
  const out: WindowReading[] = [];
  for (const raw of [limit?.primary_window, limit?.secondary_window]) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown };
    if (typeof row.used_percent !== 'number' || typeof row.limit_window_seconds !== 'number') continue;
    const base = windowByLength(row.limit_window_seconds);
    out.push({
      key: scope ? `${base.key}:${scope}` : base.key,
      label: scope ? `${base.label} · ${scope}` : base.label,
      usedPct: clampPct(row.used_percent),
      resetsAt: typeof row.reset_at === 'number' ? row.reset_at * 1000 : null,
    });
  }
  return out;
}

export async function probeCodex(codexHome: string, fetchFn: Fetch): Promise<UsageReading> {
  const auth = readCodexAuth(codexHome);
  if (!auth) throw new Error('no login under this Codex home');
  const headers: Record<string, string> = { Authorization: `Bearer ${auth.accessToken}`, 'User-Agent': 'flightdeck' };
  if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId;
  const response = await fetchFn('https://chatgpt.com/backend-api/wham/usage', { headers });
  if (response.status !== 200) throw new Error(`usage read failed: HTTP ${response.status}`);
  const reading = parseCodexUsage(await response.text());
  return {
    email: reading.email ?? auth.email,
    plan: reading.plan ?? auth.plan,
    windows: reading.windows,
  } as UsageReading;
}

export function probeAccount(provider: Provider, dir: string, fetchFn: Fetch): Promise<UsageReading> {
  return provider === 'codex' ? probeCodex(dir, fetchFn) : probeClaude(dir, fetchFn);
}

/** The email and plan a fresh login carries, read off disk with no network. */
export function identityOnDisk(provider: Provider, dir: string): { email?: string; plan?: string } {
  if (provider === 'codex') {
    const auth = readCodexAuth(dir);
    return auth ? { ...(auth.email ? { email: auth.email } : {}), ...(auth.plan ? { plan: auth.plan } : {}) } : {};
  }
  return {};
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

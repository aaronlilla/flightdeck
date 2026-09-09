import type { Integration, NarrationBag } from '../../shared/console-model.js';
import { integrationWordsFor } from '../../shared/integration-words.js';

/**
 * A stub row's three registers. The sentences here are the ones the real narrator wrote
 * for these same rows on 2026-09-09, kept so the stub exercises the disclosure and the
 * verbose block rather than pretending the layer is off; `raw` is the fact record the
 * server would have built, identifiers intact.
 */
const NARRATED: Record<string, NarrationBag> = {
  aws: {
    status: {
      glance: 'Not connected — SSO token expired · profile default (12h lifetime)',
      detail: 'AWS is not connected: the SSO token for profile default expired, and those tokens last 12 hours.',
      raw: 'surface: integration.status | blocks: 3 | scope: default | status: down',
      narratedAt: 1_788_000_000_000,
    },
    note: {
      glance: 'FLT-211, FLT-212, FLT-213 queued, cannot provision · running lanes unaffected',
      detail: 'FLT-211, FLT-212 and FLT-213 are queued and cannot provision a sandbox. Lanes already running are unaffected.',
      raw: 'surface: integration.note | blocks: 3 | scope: default | status: down',
      narratedAt: 1_788_000_000_000,
    },
  },
  'mcp-postgres-ro': {
    note: {
      glance: 'degraded · p95 1.9s (normal 80ms) · 2 agents slowed',
      detail: 'postgres-ro is answering, but its p95 is 1.9s against a normal 80ms, and 2 agents are slowed by it.',
      raw: 'surface: integration.note | status: degraded',
      narratedAt: 1_788_000_000_000,
    },
  },
};

/** Fills in the two sentences the real route composes, and attaches the registers the
 *  narrator wrote for the rows that have them. A row with no entry keeps one sentence in
 *  all three registers, which is exactly what a console with `FORGE_NARRATE=off` serves. */
function seeded(rows: Omit<Integration, 'words'>[]): Integration[] {
  return rows.map((row) => {
    const withWords: Integration = { ...row, words: { status: '', note: '' } };
    const words = integrationWordsFor(withWords);
    const bag = NARRATED[row.id];
    const glance = {
      status: bag?.['status']?.glance ?? words.status,
      note: bag?.['note']?.glance ?? words.note,
    };
    return { ...withWords, words: glance, ...(bag ? { narration: bag } : {}) };
  });
}

export function seedIntegrations(): Integration[] {
  const now = Date.now();
  return seeded([
    {
      id: 'github', kind: 'conn', name: 'GitHub', desc: 'org flightdeck · 4 repos · PR write, checks read', latencyMs: 82,
      status: 'ok', checkedAt: now, since: null, cause: null, effect: null, fix: null, fixLabel: null,
      scope: null, lastHealthyAt: now, retryCount: 0, dependents: [], step: null, canConnect: true, links: {},
      mcpState: null, lastError: null,
    },
    {
      id: 'jira', kind: 'conn', name: 'Jira', desc: 'projects FLT, BBZ · status + comment writes', latencyMs: 140,
      status: 'ok', checkedAt: now, since: null, cause: null, effect: null, fix: null, fixLabel: null,
      scope: null, lastHealthyAt: now, retryCount: 0, dependents: [], step: null, canConnect: false, links: {},
      mcpState: null, lastError: null,
    },
    {
      id: 'aws', kind: 'conn', name: 'AWS sandboxes', desc: 'provisions every lane',
      latencyMs: null, status: 'down', checkedAt: now, since: now - 15 * 60_000,
      cause: 'SSO token expired · profile default (12h lifetime)',
      effect: 'FLT-211, FLT-212, FLT-213 queued, cannot provision · running lanes unaffected',
      fix: 'Reconnect via SSO → verify → 3 blocked lane(s) resume',
      fixLabel: 'Reconnect AWS via SSO',
      scope: 'default', lastHealthyAt: now - 18 * 60_000, retryCount: 2,
      dependents: ['FLT-211', 'FLT-212', 'FLT-213'], step: 0, canConnect: true, links: {},
      mcpState: null, lastError: null,
    },
    {
      id: 'model-provider', kind: 'conn', name: 'Model provider', desc: 'opus-4 · sonnet-4 · haiku-3 · rate limit 62% used',
      latencyMs: 610, status: 'ok', checkedAt: now, since: null, cause: null, effect: null, fix: null,
      fixLabel: null, scope: null, lastHealthyAt: now, retryCount: 0, dependents: [], step: null, canConnect: false, links: {},
      mcpState: null, lastError: null,
    },
    {
      id: 'slack', kind: 'conn', name: 'Slack', desc: 'not connected · parks and merges → #eng', latencyMs: null,
      status: 'off', checkedAt: now, since: null, cause: null, effect: null, fix: null, fixLabel: null,
      scope: null, lastHealthyAt: null, retryCount: 0, dependents: [], step: null, canConnect: false, links: {},
      mcpState: null, lastError: null,
    },
    {
      id: 'mcp-filesystem', kind: 'mcp', name: 'filesystem', desc: 'sandbox-scoped read/write · 6 tools', latencyMs: 4,
      status: 'ok', checkedAt: now, since: null, cause: null, effect: null, fix: null, fixLabel: null,
      scope: null, lastHealthyAt: now, retryCount: 0, dependents: [], step: null, canConnect: false, links: { tools: '#', logs: '#' },
      mcpState: 'connected', lastError: null,
    },
    {
      id: 'mcp-browser', kind: 'mcp', name: 'browser', desc: 'headless · allow-list 14 domains · 9 tools', latencyMs: 220,
      status: 'ok', checkedAt: now, since: null, cause: null, effect: null, fix: null, fixLabel: null,
      scope: null, lastHealthyAt: now, retryCount: 0, dependents: [], step: null, canConnect: false, links: { tools: '#', logs: '#' },
      mcpState: 'connected', lastError: null,
    },
    {
      id: 'mcp-postgres-ro', kind: 'mcp', name: 'postgres-ro', desc: 'degraded · p95 1.9s (normal 80ms) · 2 agents slowed',
      latencyMs: 1900, status: 'degraded', checkedAt: now, since: now - 5 * 60_000,
      cause: null, effect: null, fix: null, fixLabel: null,
      scope: null, lastHealthyAt: now - 5 * 60_000, retryCount: 0, dependents: [], step: null, canConnect: false, links: { tools: '#', logs: '#' },
      mcpState: 'pending-approval', lastError: null,
    },
    {
      id: 'mcp-council-judge', kind: 'mcp', name: 'council-judge', desc: '3 reviewer agents · merge gate', latencyMs: null,
      status: 'ok', checkedAt: now, since: null, cause: null, effect: null, fix: null, fixLabel: null,
      scope: null, lastHealthyAt: now, retryCount: 0, dependents: [], step: null, canConnect: false, links: {},
      mcpState: 'connected', lastError: null,
    },
  ]);
}

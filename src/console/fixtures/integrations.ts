import type { Integration } from '../../shared/console-model.js';

export function seedIntegrations(): Integration[] {
  const now = Date.now();
  return [
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
  ];
}

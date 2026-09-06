import type { Integration } from '../../shared/console-model.js';

export function seedIntegrations(): Integration[] {
  const now = Date.now();
  return [
    {
      id: 'github', kind: 'conn', name: 'GitHub', desc: 'PR reads and merges', latencyMs: 82,
      status: 'ok', checkedAt: now, since: null, cause: null, effect: null, fix: null, fixLabel: null,
      dependents: [], step: null, links: {},
    },
    {
      id: 'jira', kind: 'conn', name: 'Jira', desc: 'ticket writes', latencyMs: 140,
      status: 'ok', checkedAt: now, since: null, cause: null, effect: null, fix: null, fixLabel: null,
      dependents: [], step: null, links: {},
    },
    {
      id: 'aws', kind: 'conn', name: 'AWS sandboxes', desc: 'provisioning for new runs',
      latencyMs: null, status: 'down', checkedAt: now, since: now - 15 * 60_000,
      cause: 'the SSO session for the sandbox account expired',
      effect: '3 lanes cannot provision and are blocked',
      fix: 'reconnect via SSO',
      fixLabel: 'Reconnect via SSO',
      dependents: ['FLT-211', 'FLT-212', 'FLT-213'], step: 0, links: {},
    },
    {
      id: 'model-provider', kind: 'conn', name: 'Model provider', desc: 'the fleet login session',
      latencyMs: 61, status: 'ok', checkedAt: now, since: null, cause: null, effect: null, fix: null,
      fixLabel: null, dependents: [], step: null, links: {},
    },
    {
      id: 'codex', kind: 'conn', name: 'Codex', desc: 'read-only review', latencyMs: null,
      status: 'off', checkedAt: now, since: null, cause: null, effect: null, fix: null, fixLabel: null,
      dependents: [], step: null, links: {},
    },
    {
      id: 'mcp-filesystem', kind: 'mcp', name: 'filesystem', desc: 'file read/write tools', latencyMs: 4,
      status: 'ok', checkedAt: now, since: null, cause: null, effect: null, fix: null, fixLabel: null,
      dependents: [], step: null, links: { tools: '#', logs: '#' },
    },
    {
      id: 'mcp-postgres-ro', kind: 'mcp', name: 'postgres-ro', desc: 'read-only DB access',
      latencyMs: 310, status: 'degraded', checkedAt: now, since: now - 5 * 60_000,
      cause: null, effect: null, fix: null, fixLabel: null,
      dependents: [], step: null, links: { tools: '#', logs: '#' },
    },
  ];
}

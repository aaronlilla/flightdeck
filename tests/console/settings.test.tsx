// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Settings } from '../../src/console/components/Settings.js';
import type { Integration } from '../../src/shared/console-model.js';

function integration(extra: Partial<Integration> = {}): Integration {
  return {
    id: 'mcp-x', kind: 'mcp', name: 'mcp-x', desc: 'a tool server', latencyMs: null,
    status: 'ok', checkedAt: Date.now(), since: null, cause: null, effect: null, fix: null, fixLabel: null,
    scope: null, lastHealthyAt: null, retryCount: 0, dependents: [], step: null, links: {},
    ...extra,
  };
}

const noop = vi.fn();

function renderSettings(integrations: Integration[]) {
  return render(
    <Settings
      integrations={integrations} caps={null} journalCount={0}
      onCheck={noop} onReconnect={noop} onCheckAll={noop} onSaveCaps={noop} onOpenJournal={noop}
    />,
  );
}

// POLISH-2 #3: an MCP server's null latency reads "stdio" once it's healthy, and its
// action reads "manage" when ok, "Fix →" when down.
describe('Settings MCP rows', () => {
  it('prints stdio, not --, for a healthy MCP row with no measured latency', () => {
    renderSettings([integration({ status: 'ok', latencyMs: null })]);
    expect(screen.getByText('stdio')).toBeInTheDocument();
    expect(screen.queryByText('--')).not.toBeInTheDocument();
  });

  it('offers manage on a healthy MCP row', () => {
    renderSettings([integration({ status: 'ok' })]);
    expect(screen.getByText('manage')).toBeInTheDocument();
  });

  it('offers Fix -> on a down MCP row instead of the connection-style reconnect label', () => {
    renderSettings([integration({ status: 'down', fixLabel: 'Reconnect via SSO' })]);
    expect(screen.getByText('Fix →')).toBeInTheDocument();
  });

  it('still shows -- for a conn row with no latency (unaffected by the MCP rule)', () => {
    renderSettings([integration({ kind: 'conn', status: 'ok', latencyMs: null })]);
    expect(screen.getByText('--')).toBeInTheDocument();
  });
});

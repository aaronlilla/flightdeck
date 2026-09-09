// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { controlFor, IntegrationsPanel } from '../../src/console/components/IntegrationsPanel.js';
import { MCP_CONN_STATES, type Integration, type McpConnState } from '../../src/shared/console-model.js';

function integration(extra: Partial<Integration> = {}): Integration {
  return {
    id: 'mcp-x', kind: 'mcp', name: 'mcp-x', desc: 'a tool server', latencyMs: null,
    status: 'ok', checkedAt: Date.now(), since: null, cause: null, effect: null, fix: null, fixLabel: null,
    scope: null, lastHealthyAt: null, retryCount: 0, dependents: [], step: null, canConnect: false, links: {},
    mcpState: 'connected', lastError: null,
    ...extra,
  };
}

const EXPECTED: Record<McpConnState, 'connect' | 'open' | 'none'> = {
  unknown: 'connect',
  'needs-login': 'connect',
  failed: 'connect',
  connecting: 'open',
  connected: 'none',
  'pending-approval': 'none',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('controlFor', () => {
  it('covers every state MCP_CONN_STATES exports, not a hand-picked subset', () => {
    // Red-first proof: MCP_CONN_STATES is the single source of truth here. If W2's
    // union gains a state and this map is not updated, this loop finds it missing.
    for (const state of MCP_CONN_STATES) {
      expect(controlFor(state), state).toBe(EXPECTED[state]);
    }
    // And the reverse: nothing in EXPECTED that MCP_CONN_STATES does not also carry.
    expect(Object.keys(EXPECTED).sort()).toEqual([...MCP_CONN_STATES].sort());
  });
});

describe('IntegrationsPanel rendering per state', () => {
  for (const state of MCP_CONN_STATES) {
    it(`renders the ${EXPECTED[state]} control for ${state}`, () => {
      render(<IntegrationsPanel items={[integration({ mcpState: state })]} now={Date.now()} />);
      const connect = screen.queryByTestId('integration-connect-mcp-x');
      const open = screen.queryByTestId('integration-open-mcp-x');
      expect(Boolean(connect), `${state} connect button`).toBe(EXPECTED[state] === 'connect');
      expect(Boolean(open), `${state} open button`).toBe(EXPECTED[state] === 'open');
    });
  }

  it('shows the verbatim CLI error text for a failed row, not a generic sentence', () => {
    render(<IntegrationsPanel items={[integration({ mcpState: 'failed', lastError: 'exit code 17: token expired for real-server-name' })]} now={Date.now()} />);
    expect(screen.getByTestId('integration-state-mcp-x').textContent).toBe('exit code 17: token expired for real-server-name');
  });

  it('starts a connect attempt by POSTing to /integrations/:id/connect directly, not through api.ts', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ attempt: 'att-1' }), text: async () => '' });
    vi.stubGlobal('fetch', fetchSpy);
    render(<IntegrationsPanel items={[integration({ mcpState: 'unknown' })]} now={Date.now()} />);
    screen.getByTestId('integration-connect-mcp-x').click();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/integrations/mcp-x/connect', expect.objectContaining({ method: 'POST' })));
  });

  it('the Open button fetches the attempt at click time and never stores the link past the click', async () => {
    const opened: string[] = [];
    vi.stubGlobal('open', (url: string) => { opened.push(url); });
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ attempt: 'att-2' }), text: async () => '' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ state: 'connecting', link: 'https://example.com/authorize?token=secret' }), text: async () => '' });
    vi.stubGlobal('fetch', fetchSpy);
    render(<IntegrationsPanel items={[integration({ mcpState: 'unknown' })]} now={Date.now()} />);
    screen.getByTestId('integration-connect-mcp-x').click();
    await vi.waitFor(() => screen.getByTestId('integration-open-mcp-x'));
    screen.getByTestId('integration-open-mcp-x').click();
    await vi.waitFor(() => expect(opened).toEqual(['https://example.com/authorize?token=secret']));
    // Two fetches only: the connect POST and the one attempt GET behind the click.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

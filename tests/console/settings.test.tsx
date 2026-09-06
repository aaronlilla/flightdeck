// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Settings, type SettingsProps } from '../../src/console/components/Settings.js';
import type {
  Feed, Integration, JournalEntry, Lane, Rule,
} from '../../src/shared/console-model.js';

function integration(extra: Partial<Integration> = {}): Integration {
  return {
    id: 'mcp-x', kind: 'mcp', name: 'mcp-x', desc: 'a tool server', latencyMs: null,
    status: 'ok', checkedAt: Date.now(), since: null, cause: null, effect: null, fix: null, fixLabel: null,
    scope: null, lastHealthyAt: null, retryCount: 0, dependents: [], step: null, links: {},
    ...extra,
  };
}

function rule(extra: Partial<Rule> = {}): Rule {
  return {
    id: 'r1', kind: 'cost', title: 'a rule', summary: 'summary', evidence: 'evidence', effect: 'effect',
    status: 'open', jid: null, prUrl: null,
    ...extra,
  };
}

function lane(extra: Partial<Lane> = {}): Lane {
  return {
    id: 'FLT-1', ticket: null, model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-rn', attempt: 1, state: 'running', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 1000, ctxCeiling: 200_000, ctxCompactAt: 180_000, costUsd: 1, capUsd: 10, burnUsdPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(),
    startedAt: Date.now(), endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null,
    runaway: false, needsAaron: null,
    ...extra,
  };
}

const noop = vi.fn();

const NO_FEED: Feed = { live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: null };

function renderSettings(overrides: Partial<SettingsProps> & { integrations: Integration[] }) {
  return render(
    <Settings
      caps={null} journalCount={0} journal={[]} rules={[]} lanes={[]}
      feed={NO_FEED} now={Date.now()}
      onCheck={noop} onReconnect={noop} onCheckAll={noop} onSaveCaps={noop} onOpenJournal={noop}
      {...overrides}
    />,
  );
}

// POLISH-2 #3: an MCP server's null latency reads "stdio" once it's healthy, and its
// action reads "manage" when ok, "Fix →" when down.
describe('Settings MCP rows', () => {
  it('prints stdio, not --, for a healthy MCP row with no measured latency', () => {
    renderSettings({ integrations: [integration({ status: 'ok', latencyMs: null })] });
    expect(screen.getByText('stdio')).toBeInTheDocument();
    expect(screen.queryByText('--')).not.toBeInTheDocument();
  });

  it('offers manage on a healthy MCP row', () => {
    renderSettings({ integrations: [integration({ status: 'ok' })] });
    expect(screen.getByText('manage')).toBeInTheDocument();
  });

  it('offers Fix -> on a down MCP row instead of the connection-style reconnect label', () => {
    renderSettings({ integrations: [integration({ status: 'down', fixLabel: 'Reconnect via SSO' })] });
    expect(screen.getByText('Fix →')).toBeInTheDocument();
  });

  it('still shows -- for a conn row with no latency (unaffected by the MCP rule)', () => {
    renderSettings({ integrations: [integration({ kind: 'conn', status: 'ok', latencyMs: null })] });
    expect(screen.getByText('--')).toBeInTheDocument();
  });
});

describe('Settings section sidebar', () => {
  it('renders all seven sections, Integrations active by default', () => {
    renderSettings({ integrations: [] });
    for (const id of ['integrations', 'caps', 'models', 'repos', 'notifications', 'shortcuts']) {
      expect(screen.getByTestId(`settings-nav-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByText(/Audit journal/)).toBeInTheDocument();
    expect(screen.getByTestId('settings-nav-integrations')).toHaveStyle({ fontWeight: '700' });
  });

  it('dims Caps & policies less than the other inactive sections, matching the prototype', () => {
    renderSettings({ integrations: [] });
    const caps = screen.getByTestId('settings-nav-caps');
    const models = screen.getByTestId('settings-nav-models');
    expect(caps).toHaveStyle({ color: 'var(--ink2)' });
    expect(models).toHaveStyle({ color: 'var(--ink3)' });
  });

  it('switches the center panel when a section is clicked, without touching the right rail', () => {
    renderSettings({ integrations: [] });
    fireEvent.click(screen.getByTestId('settings-nav-shortcuts'));
    expect(screen.getByText('⌘K / Ctrl+K')).toBeInTheDocument();
    expect(screen.getByText('Esc')).toBeInTheDocument();
    // the right rail's Caps & policies box is always present, section or no section
    expect(screen.getByText('org hard limit')).toBeInTheDocument();
  });

  it('shows an honest empty state for models & routing with no lanes', () => {
    renderSettings({ integrations: [] });
    fireEvent.click(screen.getByTestId('settings-nav-models'));
    expect(screen.getByText('no lanes have reported a model class yet')).toBeInTheDocument();
  });

  it('groups lanes by class for models & routing when lanes exist', () => {
    renderSettings({
      integrations: [],
      lanes: [lane({ className: 'implement', model: 'sonnet-5' }), lane({ id: 'FLT-2', className: 'implement', model: 'opus-5' })],
    });
    fireEvent.click(screen.getByTestId('settings-nav-models'));
    expect(screen.getByText('implement')).toBeInTheDocument();
    expect(screen.getByText(/opus-5, sonnet-5 · 2 lanes/)).toBeInTheDocument();
  });

  it('shows an honest empty state for repos & queues with no lanes', () => {
    renderSettings({ integrations: [] });
    fireEvent.click(screen.getByTestId('settings-nav-repos'));
    expect(screen.getByText('no repos have queued lanes yet')).toBeInTheDocument();
  });
});

// FIDELITY-DIFFS row 64: the cap-enforcement status is live-derived from whether the
// kill3 rule has actually fired, never a fixed "on".
describe('Settings cap enforcement status', () => {
  it('reads ok · rule kill3 backstop, in the run color, once kill3 has been applied', () => {
    renderSettings({ integrations: [], rules: [rule({ id: 'kill3', status: 'applied' })] });
    expect(screen.getByText('ok · rule kill3 backstop')).toBeInTheDocument();
  });

  it('reads not enforced yet, in the block color, while kill3 is still open', () => {
    renderSettings({ integrations: [], rules: [rule({ id: 'kill3', status: 'open' })] });
    expect(screen.getByText('not enforced yet')).toBeInTheDocument();
  });

  it('falls back to the caps config on/off when no kill3 rule exists', () => {
    renderSettings({
      integrations: [], rules: [],
      caps: {
        dailyUsd: 40, runUsd: 10, hardUsd: 100, enforcement: 'on', spentTodayUsd: 0, overrides: {},
        sources: { dailyUsd: 'policy', runUsd: 'policy', hardUsd: 'policy' },
      },
    });
    expect(screen.getByText('on')).toBeInTheDocument();
  });
});

// FIDELITY-DIFFS row 65: connection/MCP rows show a freshness stamp, not the bare
// status word.
describe('Settings row freshness', () => {
  it('shows observed hh:mm for a down row', () => {
    const checkedAt = new Date(2026, 0, 1, 13, 57, 0).getTime();
    renderSettings({ integrations: [integration({ kind: 'conn', status: 'down', checkedAt })] });
    expect(screen.getByText('observed 13:57')).toBeInTheDocument();
  });

  it('shows a verified-seconds-ago stamp for a healthy row with a checkedAt', () => {
    const now = Date.now();
    renderSettings({ integrations: [integration({ kind: 'conn', status: 'ok', checkedAt: now - 5000 })], now });
    expect(screen.getByText('✓ 5s ago')).toBeInTheDocument();
  });
});

// FIDELITY-DIFFS rows 38/75/76: the down plate carries scope, footer, and the exact
// "Reconnect AWS via SSO" / "≈ 20s" text.
describe('Settings down plate', () => {
  it('renders the scope chip, the cause/effect/fix, and the last-healthy/retry footer', () => {
    renderSettings({
      integrations: [integration({
        id: 'aws', kind: 'conn', status: 'down', name: 'AWS', scope: 'default',
        cause: 'FORGE_AWS_PROFILE is not set', effect: 'FLT-1 blocked', fix: 'Reconnect AWS via SSO → verify',
        fixLabel: 'Reconnect AWS via SSO', lastHealthyAt: new Date(2026, 0, 1, 13, 57, 40).getTime(), retryCount: 2,
        dependents: ['FLT-1'],
      })],
    });
    expect(screen.getByText('default')).toBeInTheDocument();
    expect(screen.getByText('Reconnect AWS via SSO →')).toBeInTheDocument();
    expect(screen.getByText('last healthy 13:57 · 2 auto-retries failed')).toBeInTheDocument();
    expect(screen.getByText('≈ 20s · no restart')).toBeInTheDocument();
  });
});

describe('Settings recent journal', () => {
  it('lists the last journal entries under Recent, newest first', () => {
    const journal: JournalEntry[] = [
      { jid: 'J-1', ts: 1000, kind: 'k', text: 'first', actor: 'operator', run: null, undoable: false, undone: false },
      { jid: 'J-2', ts: 2000, kind: 'k', text: 'second', actor: 'operator', run: null, undoable: false, undone: false },
    ];
    renderSettings({ integrations: [], journal });
    const secondIndex = screen.getByText('second').compareDocumentPosition(screen.getByText('first'));
    // eslint-disable-next-line no-bitwise
    expect(secondIndex & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows an honest empty state with no journal entries', () => {
    renderSettings({ integrations: [], journal: [] });
    expect(screen.getByText('no journal entries yet')).toBeInTheDocument();
  });
});

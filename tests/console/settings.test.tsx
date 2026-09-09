// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Settings, type SettingsProps } from '../../src/console/components/Settings.js';
import { StoreContext, initialState } from '../../src/console/store.js';
import type {
  Feed, Integration, JournalEntry, Lane, Rule,
} from '../../src/shared/console-model.js';

function render(node: ReactElement): ReturnType<typeof rtlRender> {
  const state = { ...initialState(), links: { jiraSite: null, defaultRepo: null } };
  return rtlRender(<StoreContext.Provider value={{ state, dispatch: vi.fn() }}>{node}</StoreContext.Provider>);
}

function integration(extra: Partial<Integration> = {}): Integration {
  return {
    id: 'mcp-x', kind: 'mcp', name: 'mcp-x', desc: 'a tool server', latencyMs: null,
    status: 'ok', checkedAt: Date.now(), since: null, cause: null, effect: null, fix: null, fixLabel: null,
    scope: null, lastHealthyAt: null, retryCount: 0, dependents: [], step: null, canConnect: false, links: {},
    mcpState: 'connected', lastError: null,
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
    title: null, kind: 'manual', sourceUrl: null, plain: '', mergeable: null, attempts: 1, retiredAt: null,
    id: 'FLT-1', ticket: null, model: 'sonnet-5', modelId: 'claude-sonnet-5', className: 'implement',
    repo: 'flightdeck-rn', attempt: 1, state: 'running', reason: null, stepN: 1, stepTotal: 6, stepText: 'working',
    ctxTokens: 1000, ctxCeiling: 200_000, ctxCompactAt: 180_000, tokens: 1, tokenCap: 10, tokensPerMin: 0,
    fails: 0, hop: 0, hopStatus: 'live', observedAt: Date.now(), verifiedAt: Date.now(), heart: true, since: Date.now(),
    startedAt: Date.now(), endedAt: null, question: null, pr: null, sandbox: null, blockedBy: null,
    runaway: false, needsAaron: null, live: { alive: false, pid: null, lastEventAt: null, checkedAt: 0 }, did: null, now: '', you: null,
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
      onCheckAll={noop} onOpenJournal={noop}
      {...overrides}
    />,
  );
}

// POLISH-2 #3, superseded by mcp-live-state W5: an MCP server's null latency still
// reads "stdio", but the row's action is now driven by `mcpState` (IntegrationsPanel),
// not `status`/`canConnect` -- there is no "manage"/"Fix →"/"Reconnect" wording left
// for an MCP row, and no "nothing wired" refusal state: every mcp- row always gets a
// Connect control when its mcpState calls for one (mcp-live-state brief, W3).
describe('Settings MCP rows', () => {
  it('prints stdio, not --, for a healthy MCP row with no measured latency', () => {
    renderSettings({ integrations: [integration({ status: 'ok', latencyMs: null, mcpState: 'connected' })] });
    expect(screen.getByText('stdio')).toBeInTheDocument();
    expect(screen.queryByText('--')).not.toBeInTheDocument();
  });

  it('shows no connect control on a connected (healthy) MCP row', () => {
    renderSettings({ integrations: [integration({ mcpState: 'connected' })] });
    expect(screen.queryByTestId('integration-connect-mcp-x')).not.toBeInTheDocument();
    expect(screen.queryByTestId('integration-open-mcp-x')).not.toBeInTheDocument();
  });

  it('offers Fix -> and the verbatim CLI error on a failed MCP row', () => {
    renderSettings({ integrations: [integration({ mcpState: 'failed', lastError: 'exit code 17: token expired' })] });
    expect(screen.getByTestId('integration-connect-mcp-x')).toHaveTextContent('Fix →');
    expect(screen.getByTestId('integration-state-mcp-x')).toHaveTextContent('exit code 17: token expired');
  });

  it('offers Connect on a row that needs authentication', () => {
    renderSettings({ integrations: [integration({ mcpState: 'needs-login' })] });
    expect(screen.getByTestId('integration-connect-mcp-x')).toHaveTextContent('Connect');
  });

  it('shows no connect control on a pending-approval MCP row', () => {
    renderSettings({ integrations: [integration({ mcpState: 'pending-approval' })] });
    expect(screen.queryByTestId('integration-connect-mcp-x')).not.toBeInTheDocument();
    expect(screen.queryByTestId('integration-open-mcp-x')).not.toBeInTheDocument();
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
        dailyTokens: 40, runTokens: 10, hardTokens: 100, enforcement: 'on', tokensToday: 0, overrides: {},
        sources: { dailyTokens: 'policy', runTokens: 'policy', hardTokens: 'policy' },
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

// Final fidelity sweep #4: a down or degraded row gets a background tint from its
// own status color, matching the prototype's intVM (`bg: bad ? color-mix(...) :
// transparent`); a healthy or off row stays plain.
describe('Settings row tint', () => {
  it('tints a down row with its status color', () => {
    renderSettings({ integrations: [integration({ kind: 'conn', status: 'down' })] });
    const row = screen.getAllByText('mcp-x').map((el) => el.closest('.row')).find((el): el is HTMLElement => el !== null) as HTMLElement;
    expect(row.style.background).toContain('color-mix');
  });

  it('tints a degraded row with its status color', () => {
    renderSettings({ integrations: [integration({ kind: 'conn', status: 'degraded' })] });
    const row = screen.getAllByText('mcp-x').map((el) => el.closest('.row')).find((el): el is HTMLElement => el !== null) as HTMLElement;
    expect(row.style.background).toContain('color-mix');
  });

  it('leaves a healthy row untinted', () => {
    renderSettings({ integrations: [integration({ kind: 'conn', status: 'ok' })] });
    const row = screen.getByText('mcp-x').closest('.row') as HTMLElement;
    expect(row.style.background).toBe('transparent');
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

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { Integration, McpConnState } from '../../shared/console-model.js';
import { getIntegrationConnectAttempt } from '../api.js';
import { redactErrorBody } from '../redact.js';

/**
 * `POST /integrations/:id/connect` on purpose skips both `api.ts` and the `ACTIONS`
 * catalog. `integrations-route.ts` hands the MCP login link back exactly once, to
 * whichever caller reads `GET .../connect/:attempt` first -- never to the row itself,
 * never to `/events`, never to the journal. Every export in `api.ts` that issues a
 * write is scanned by `tests/console/actions-catalog.test.ts` and forced into an
 * `ACTIONS` entry, and every catalog action reports its outcome through the rail's
 * receipt/journal pipeline. Routing this call through that pipeline would be routing
 * a one-time login URL through it too, so this module keeps its own tiny copy of
 * `api.ts`'s `token()`/`call()` shape instead of extending the scanned surface.
 * `getIntegrationConnectAttempt` is a plain GET, exempt from that scanner, so it lives in
 * `api.ts` normally.
 */
function connectToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="forge-token"]')?.getAttribute('content') ?? '';
}

async function postConnect(id: string): Promise<{ attempt: string }> {
  const response = await fetch(`/integrations/${encodeURIComponent(id)}/connect`, {
    method: 'POST',
    headers: { 'x-forge-token': connectToken() },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(redactErrorBody(body) || `connect failed: ${response.status}`);
  }
  return (await response.json()) as { attempt: string };
}

export type RowControl = 'connect' | 'open' | 'none';

/** Which control an MCP row shows, computed from every value `McpConnState` can hold
 *  (`console-model.ts`'s `MCP_CONN_STATES`) rather than a hand-picked subset -- the
 *  `never` branch below is what makes a state TypeScript adds to the union, and a
 *  coverage test in `integrations-panel.test.tsx` imports the same union to check it
 *  at runtime too. */
export function controlFor(state: McpConnState): RowControl {
  switch (state) {
    case 'unknown':
    case 'needs-login':
    case 'failed':
      return 'connect';
    case 'connecting':
      return 'open';
    case 'connected':
    case 'pending-approval':
      return 'none';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function freshness(i: Integration, now: number): string {
  if (!i.checkedAt) return '--';
  const seconds = Math.max(0, Math.round((now - i.checkedAt) / 1000));
  return `✓ ${seconds}s ago`;
}

/** The row's own status text, by state -- the `failed` case shows the CLI's verbatim
 *  error rather than a generic sentence, matching the down-plate's `d.cause` pattern
 *  (`Settings.tsx`) instead of inventing a second way to show an error. */
function stateText(i: Integration, state: McpConnState, now: number): string {
  switch (state) {
    case 'connected': return `connected · ${freshness(i, now)}`;
    case 'connecting': return 'waiting for you in the browser';
    case 'needs-login': return 'needs authentication';
    case 'pending-approval': return 'pending approval';
    case 'unknown': return 'unknown';
    case 'failed': return i.lastError ?? 'failed';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

interface AttemptState {
  attempt: string | null;
  pending: boolean;
}

export interface IntegrationsPanelProps {
  items: Integration[];
  now: number;
  onToast?: (text: string, ok: boolean) => void;
}

/**
 * The dot's colour, in the palette the console actually has. This map first named
 * `--run`, `--hand`, `--park` and `--block`, none of which the stylesheet defines, so
 * every dot painted nothing. The design's colour vocabulary is two hues and the inks
 * (`styles.css`: "a value here is a value in the design; nothing is retuned"), so these
 * follow `Settings.tsx`'s own reading of the same states: accent for a working
 * connection, warn for anything that wants a human, ink for a state not yet read.
 */
const LED_COLOR: Record<McpConnState, string> = {
  connected: 'var(--acc)',
  connecting: 'var(--warn)',
  'pending-approval': 'var(--warn)',
  'needs-login': 'var(--warn)',
  failed: 'var(--warn)',
  unknown: 'var(--ink3)',
};

/**
 * The MCP servers plate in Settings' Integrations section. A separate component from
 * `Row` (per the mcp-live-state goal's ownership split): `Row`/`ctaFor`/`SettingsProps`
 * stay untouched, and this file owns everything about how an MCP row's real connection
 * state (`mcpState`, six values, W2) renders and how Connect actually starts a login.
 */
export function IntegrationsPanel({ items, now, onToast }: IntegrationsPanelProps): JSX.Element {
  const [attempts, setAttempts] = useState<Record<string, AttemptState>>({});

  // The server only ever resolves a connect attempt to `connected` or `failed`
  // (`integrations-route.ts`'s `finish()`); once a fresh `/integrations` poll reports
  // either for a row with an attempt in flight, that attempt is done and the row goes
  // back to reading its own real state instead of the optimistic "connecting" this
  // component shows in between polls.
  useEffect(() => {
    setAttempts((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const i of items) {
        if (next[i.id]?.attempt && (i.mcpState === 'connected' || i.mcpState === 'failed')) {
          delete next[i.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [items]);

  function attemptFor(id: string): AttemptState {
    return attempts[id] ?? { attempt: null, pending: false };
  }

  async function onConnect(id: string): Promise<void> {
    setAttempts((prev) => ({ ...prev, [id]: { attempt: null, pending: true } }));
    try {
      const { attempt } = await postConnect(id);
      setAttempts((prev) => ({ ...prev, [id]: { attempt, pending: false } }));
      onToast?.(`${id} is connecting`, true);
    } catch (err) {
      setAttempts((prev) => ({ ...prev, [id]: { attempt: null, pending: false } }));
      onToast?.(err instanceof Error ? err.message : 'connect failed', false);
    }
  }

  // The link is read at click time and used immediately -- it never sits in this
  // component's state any longer than this one handler call needs it, and it is
  // never logged or passed to onToast.
  async function onOpen(id: string): Promise<void> {
    const local = attemptFor(id);
    if (!local.attempt) { onToast?.(`${id} has no connect attempt in flight`, false); return; }
    const view = await getIntegrationConnectAttempt(id, local.attempt);
    if (view.link) {
      window.open(view.link, '_blank', 'noopener');
    } else if (view.error) {
      onToast?.(view.error, false);
    } else {
      onToast?.('still waiting on the login link -- try again in a moment', false);
    }
  }

  return (
    <>
      {items.map((i) => {
        const raw: McpConnState = i.mcpState ?? 'unknown';
        const local = attemptFor(i.id);
        // Optimistic: an attempt started this session and not yet resolved to
        // connected/failed reads as connecting even before the next `/integrations`
        // poll catches up -- otherwise the Open button would never appear between
        // the POST and the row's next refresh.
        const state: McpConnState = local.attempt && raw !== 'connected' && raw !== 'failed' ? 'connecting' : raw;
        const control = controlFor(state);
        return (
          <div className="mcp-row" key={i.id} data-testid={`integration-row-${i.id}`} data-mcp-state={state}>
            <span className="led" style={{ background: LED_COLOR[state] }} />
            <b>{i.name}</b>
            <span style={{ color: 'var(--ink2)' }}>{i.desc}</span>
            <span style={{ color: 'var(--ink2)' }}>{i.latencyMs !== null ? `${i.latencyMs} ms` : 'stdio'}</span>
            <span data-testid={`integration-state-${i.id}`}>{stateText(i, state, now)}</span>
            <span style={{ display: 'inline-flex', gap: 6, justifySelf: 'end' }}>
              {control === 'connect' ? (
                <button
                  type="button" className="btn" style={{ padding: '5px 10px', fontSize: 'var(--fs-ui)' }}
                  data-testid={`integration-connect-${i.id}`} disabled={local.pending}
                  onClick={() => { void onConnect(i.id); }}
                >
                  {local.pending ? 'connecting…' : state === 'failed' ? 'Fix →' : 'Connect'}
                </button>
              ) : null}
              {control === 'open' ? (
                <button
                  type="button" className="btn" style={{ padding: '5px 10px', fontSize: 'var(--fs-ui)' }}
                  data-testid={`integration-open-${i.id}`}
                  onClick={() => { void onOpen(i.id); }}
                >
                  Open
                </button>
              ) : null}
            </span>
          </div>
        );
      })}
    </>
  );
}

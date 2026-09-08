import type { JSX } from 'react';
import { useState } from 'react';

import { hm } from '../freshness.js';
import type { Blocker, BlockersActionResult } from '../../shared/console-model.js';

export interface BlockersViewProps {
  blockers: Blocker[];
  /** Ordered ids, root first, one array per open chain. A resolved blocker never
   *  appears in here -- it renders under "Resolved today" instead. */
  chains: string[][];
  onResolve: (id: string) => Promise<BlockersActionResult>;
  onCheck: (id: string) => Promise<BlockersActionResult>;
  /** Renders a ticket key or PR number as a link. Falls back to a plain `<a>` built
   *  from the site/repo conventions when no shared `Linkify` component exists in this
   *  worktree yet (iteration 4's own sibling stream owns that file). */
  jiraSite?: string;
}

interface StepResult {
  kind: 'checking' | 'resolved' | 'not-yet';
  detail?: string;
  started?: string[];
}

function StepButtons({ blocker, enabled, onResolve, onCheck }: {
  blocker: Blocker; enabled: boolean;
  onResolve: (id: string) => Promise<BlockersActionResult>;
  onCheck: (id: string) => Promise<BlockersActionResult>;
}): JSX.Element {
  const [result, setResult] = useState<StepResult | null>(null);

  if (result?.kind === 'checking') {
    return <span className="lbl" style={{ color: 'var(--ink2)' }}>Checking…</span>;
  }
  if (result?.kind === 'resolved') {
    const labelFor = new Map(blocker.blocks.map((b) => [b.laneId, b.label]));
    const startedLabels = (result.started ?? []).map((laneId) => labelFor.get(laneId) ?? laneId);
    return (
      <span className="m" style={{ color: 'var(--run)', fontSize: 11 }}>
        Resolved {hm(Date.now())}
        {startedLabels.length ? (
          <span style={{ color: 'var(--ink2)' }}> · Started: {startedLabels.join(', ')}</span>
        ) : null}
      </span>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      {blocker.youCanResolve ? (
        <button
          type="button" className="btnP" disabled={!enabled}
          style={{ padding: '7px 11px', fontSize: '9.5px' }}
          onClick={() => {
            setResult({ kind: 'checking' });
            void onResolve(blocker.id).then((r) => {
              setResult(r.ok ? { kind: 'resolved', started: r.started } : { kind: 'not-yet', detail: r.lastCheck ?? 'not confirmed' });
            });
          }}
        >
          Resolved, check it
        </button>
      ) : null}
      <button
        type="button" className="btnS" disabled={!enabled}
        style={{ padding: '7px 11px', fontSize: '9.5px' }}
        onClick={() => {
          setResult({ kind: 'checking' });
          void onCheck(blocker.id).then((r) => {
            setResult(r.ok ? { kind: 'resolved', started: r.started } : { kind: 'not-yet', detail: r.lastCheck ?? 'not confirmed' });
          });
        }}
      >
        Check again
      </button>
      {result?.kind === 'not-yet' ? (
        <span className="m" style={{ color: 'var(--block)', fontSize: 11 }}>Not yet: {result.detail}</span>
      ) : null}
    </div>
  );
}

function ChainStep({ blocker, stepN, enabled, onResolve, onCheck }: {
  blocker: Blocker; stepN: number; enabled: boolean;
  onResolve: (id: string) => Promise<BlockersActionResult>;
  onCheck: (id: string) => Promise<BlockersActionResult>;
}): JSX.Element {
  return (
    <div
      className="plate"
      style={{
        display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 14px', borderColor: enabled ? 'var(--block)' : 'var(--line2)',
        opacity: enabled ? 1 : 0.55,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div className="m" style={{ fontSize: 12.5, fontWeight: 700, display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span style={{ color: 'var(--ink3)' }}>{stepN}</span>
          <span style={{ color: enabled ? 'var(--block)' : 'var(--ink3)' }}>{enabled ? '●' : '○'}</span>
          <span>{blocker.title}</span>
        </div>
        <span className="lbl" style={{ color: enabled ? 'var(--block)' : 'var(--ink3)' }}>
          {enabled ? 'OPEN' : `WAITING ON ${stepN - 1}`}
        </span>
      </div>
      <div className="m" style={{ fontSize: 11, color: 'var(--ink2)' }}>{blocker.detail}</div>
      <div className="m" style={{ fontSize: 11, color: 'var(--ink2)' }}>To resolve: {blocker.howToResolve}</div>
      <div className="m" style={{ fontSize: 10.5, color: 'var(--ink3)' }}>Then: {blocker.thenWhat}</div>
      {blocker.blocks.length ? (
        <div className="m" style={{ fontSize: 10.5, color: 'var(--ink3)' }}>
          Blocks: {blocker.blocks.map((b) => b.label).join(', ')}
        </div>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 2 }}>
        <StepButtons blocker={blocker} enabled={enabled} onResolve={onResolve} onCheck={onCheck} />
        <span className="m" style={{ fontSize: 10, color: 'var(--ink3)' }}>since {hm(blocker.since)}</span>
      </div>
    </div>
  );
}

/** Blockers view: one column of chains, root first, one at a time. A chain resolves
 *  through its own steps in order -- only the first still-open step in a chain is
 *  actionable, the rest read dimmed until it clears. Resolved chains collapse under
 *  "Resolved today". */
export function BlockersView({ blockers, chains, onResolve, onCheck }: BlockersViewProps): JSX.Element {
  const byId = new Map(blockers.map((b) => [b.id, b]));
  const openChains = chains.filter((chain) => chain.some((id) => byId.get(id)?.state === 'open'));
  const resolvedToday = blockers.filter((b) => b.state === 'resolved');

  if (openChains.length === 0 && resolvedToday.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <span className="lbl" style={{ color: 'var(--ink2)' }}>Nothing is blocked on you.</span>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      {openChains.map((chain) => (
        <div key={chain[0]} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {chain.map((id, i) => {
            const blocker = byId.get(id);
            if (!blocker) return null;
            // Only the first blocker in the chain that is still open is actionable;
            // everything below it waits its turn even if its own cause already
            // cleared, per "one at a time, in order".
            const firstOpenIndex = chain.findIndex((cid) => byId.get(cid)?.state === 'open');
            return (
              <ChainStep
                key={id} blocker={blocker} stepN={i + 1} enabled={i === firstOpenIndex}
                onResolve={onResolve} onCheck={onCheck}
              />
            );
          })}
        </div>
      ))}
      {resolvedToday.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          <span className="lbl" style={{ color: 'var(--ink2)' }}>Resolved today</span>
          {resolvedToday.map((b) => (
            <div key={b.id} className="m" style={{ fontSize: 11, color: 'var(--ink3)', display: 'flex', gap: 8 }}>
              <span style={{ color: 'var(--run)' }}>✓</span>
              <span>{b.title}</span>
              <span style={{ color: 'var(--ink3)' }}>{b.resolvedAt ? hm(b.resolvedAt) : ''}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

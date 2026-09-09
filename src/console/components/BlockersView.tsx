import type { JSX } from 'react';
import { useState } from 'react';

import { ACTIONS, useAction } from '../actions.js';
import { hm } from '../freshness.js';
import type { Blocker } from '../../shared/console-model.js';
import { narratedField } from '../../shared/console-model.js';
import { Marks } from './QuestionCard.js';

/**
 * `Flightdeck Console.dc.html` 1b: one card per open blocker, sorted by how many agents
 * it stops. Each card says what it stops, when it clears, who can do it, and offers the
 * one button that does it. Under those, the choice the blocker offers (UX rule 2: fix it,
 * or tell the agents to go on without it) and a line to the agents themselves.
 */
export interface BlockersViewProps {
  blockers: Blocker[];
  /** `?verbose=1`: the fact record behind each narrated line, identifiers intact. */
  verbose?: boolean;
  chains: string[][];
  jiraSite?: string;
  onOpenSettings?: () => void;
  /** The title of a stopped lane, next to its key; the server's own label is the key. */
  laneTitle?: (laneId: string) => string | null;
  /** Sends typed text to the agent on one lane (the `run`-scoped `POST /command`). */
  onSendToLane?: (laneId: string, text: string) => void;
}

function whoOf(blocker: Blocker): { who: string; note: string; color: string } {
  const who = blocker.who ?? (blocker.youCanResolve ? 'You' : 'Someone else');
  return { who, note: blocker.whoNote ?? '', color: who === 'You' ? 'var(--warn)' : 'var(--ink)' };
}

/**
 * The card's one `more`: the `detail` register of every narrated line on it, and under
 * `?verbose=1` the fact record each was written from. A card the narrator never saw has
 * `detail === glance` on every line and renders no disclosure at all, which is exactly
 * right -- there is nothing more to say than the sentence already on screen.
 */
function BlockerMore({ blocker, verbose }: { blocker: Blocker; verbose?: boolean }): JSX.Element | null {
  const fields: Array<[string, string | null]> = [
    ['title', blocker.title], ['detail', blocker.detail],
    ['howToResolve', blocker.howToResolve], ['thenWhat', blocker.thenWhat],
    ['whoNote', blocker.whoNote ?? null],
  ];
  const lines = fields
    .map(([name, glance]) => [name, narratedField(blocker.narration, name, glance)] as const)
    .filter(([, n]) => n.detail !== n.glance || (verbose === true && n.raw !== n.glance));
  if (lines.length === 0) return null;
  return (
    <details data-testid={`blocker-more-${blocker.id}`} style={{ margin: '2px 0 0' }}>
      <summary style={{ cursor: 'pointer', color: 'var(--ink2)', fontSize: 'var(--fs-meta)' }}>more</summary>
      {lines.map(([name, n]) => (
        <div key={name} style={{ marginTop: 4 }}>
          <span data-testid={`blocker-${name}-detail`} style={{ color: 'var(--ink2)' }}>{n.detail}</span>
          {verbose ? <pre data-testid={`blocker-${name}-raw`} style={{ margin: '2px 0 0', color: 'var(--ink3)', whiteSpace: 'pre-wrap' }}>{n.raw}</pre> : null}
        </div>
      ))}
    </details>
  );
}

function BlockerCard({ blocker, onOpenSettings, onSendToLane, laneTitle, verbose }: { blocker: Blocker; onOpenSettings?: () => void; onSendToLane?: (laneId: string, text: string) => void; laneTitle?: (laneId: string) => string | null; verbose?: boolean }): JSX.Element {
  const resolve = useAction(ACTIONS.resolveBlocker, blocker.id);
  const check = useAction(ACTIONS.checkBlocker, blocker.id);
  const [note, setNote] = useState('');
  const count = blocker.blocks.length;
  const you = blocker.youCanResolve;
  const { who, note: whoNote, color: whoColor } = whoOf(blocker);
  const link = blocker.links[0];
  const primary = blocker.kind === 'integration' && onOpenSettings
    ? { label: 'Open Settings', run: onOpenSettings }
    : you
      ? { label: resolve.pending ? 'Checking…' : 'I fixed it, check again', run: () => void resolve.run(blocker.id) }
      : link
        ? { label: `Open ${link.label}`, run: () => window.open(link.url, '_blank', 'noopener') }
        : { label: check.pending ? 'Checking…' : 'Check again', run: () => void check.run(blocker.id) };
  const result = resolve.result?.kind === 'done' ? resolve.result : check.result?.kind === 'done' ? check.result : null;
  const sendToAgents = (text: string): void => {
    if (!onSendToLane || !text.trim()) return;
    for (const lane of blocker.blocks) onSendToLane(lane.laneId, text.trim());
    setNote('');
  };
  const agents = count === 1 ? 'the agent' : count === 2 ? 'both agents' : `all ${count} agents`;
  const primaryClass = you ? 'btn warn' : 'btn';
  return (
    <div data-testid={`blocker-${blocker.id}`} className="blocker-card" style={{ position: 'relative', border: `1px solid ${you ? 'var(--warn)' : 'var(--line2)'}`, padding: '18px 20px', maxWidth: 860, display: 'grid', gridTemplateColumns: '110px 1fr 210px', gap: 22, background: you ? 'var(--warnTint)' : 'transparent' }}>
      <Marks />
      <div>
        <div className="hd" style={{ fontSize: 'var(--fs-count)', lineHeight: 1, color: you ? 'var(--warn)' : 'var(--ink)' }}>{count}</div>
        <div className="kick" style={{ fontSize: 'var(--fs-meta)', marginTop: 4 }}>{count === 1 ? 'agent stopped' : 'agents stopped'}</div>
        <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)', marginTop: 8 }}>since {hm(blocker.since)}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        <h3 className="hd" style={{ margin: 0, fontSize: 'var(--fs-cardhead)', lineHeight: 1.15 }}>{blocker.title}</h3>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', color: 'var(--ink2)', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {blocker.blocks.map((lane) => { const title = laneTitle?.(lane.laneId); return <li key={lane.laneId}><span className="hd" style={{ letterSpacing: '.05em', color: 'var(--ink)' }}>{lane.label}</span>{title && title !== lane.label ? ` ${title}` : ''}</li>; })}
        </ul>
        <p style={{ margin: '2px 0 0' }}><span className="kick" style={{ marginRight: 8 }}>Clears when</span>{blocker.howToResolve} {blocker.thenWhat}</p>
        <BlockerMore blocker={blocker} {...(verbose === undefined ? {} : { verbose })} />
        {result ? <span style={{ fontSize: 'var(--fs-meta)', color: result.ok ? 'var(--acc)' : 'var(--warn)' }}>{result.text}</span> : blocker.lastCheck ? <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>Last check: {blocker.lastCheck}</span> : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span className="kick">Who</span>
          <span className="hd" style={{ fontSize: 'var(--fs-rowhead)', color: whoColor }}>{who}</span>
          {whoNote ? <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>{whoNote}</span> : null}
        </div>
        <button type="button" className={primaryClass} data-testid="blocker-primary" aria-busy={resolve.pending || check.pending} style={{ fontSize: 'var(--fs-key)', padding: '8px 16px', minHeight: 40 }} onClick={primary.run}>{primary.label}</button>
      </div>
      <div data-testid="question-card" style={{ gridColumn: '1/-1', display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button type="button" className="opt" data-testid="question-option" data-recommended="true" onClick={primary.run}><i /><span>Clear it</span></button>
          <button type="button" className="opt" data-testid="question-option" data-recommended="false" onClick={() => sendToAgents('Finish without it; leave a note for QA')}><i /><span>Finish without it</span></button>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
          <input className="inp" data-testid="question-freetext" placeholder={`Message ${agents}…`} value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendToAgents(note); }} />
          <button type="button" className="btn" style={{ padding: '6px 14px' }} onClick={() => sendToAgents(note)}>Send</button>
        </div>
      </div>
    </div>
  );
}

function startOfToday(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function BlockersView({ blockers, chains, onOpenSettings, onSendToLane, laneTitle, verbose }: BlockersViewProps): JSX.Element {
  const byId = new Map(blockers.map((blocker) => [blocker.id, blocker]));
  const chained = chains.flat().map((id) => byId.get(id)).filter((blocker): blocker is Blocker => Boolean(blocker) && blocker!.state !== 'resolved');
  const open = [...chained, ...blockers.filter((blocker) => blocker.state !== 'resolved' && !chained.includes(blocker))]
    .sort((a, b) => b.blocks.length - a.blocks.length);
  const today = startOfToday(Date.now());
  const cleared = blockers.filter((blocker) => blocker.state === 'resolved' && (blocker.resolvedAt ?? 0) >= today);
  return (
    <main data-testid="blockers-view" className="scroll" style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '26px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      {open.map((blocker) => <BlockerCard key={blocker.id} blocker={blocker} onOpenSettings={onOpenSettings} onSendToLane={onSendToLane} laneTitle={laneTitle} {...(verbose === undefined ? {} : { verbose })} />)}
      <details style={{ maxWidth: 860, borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 6 }}>
        <summary className="disc" style={{ alignItems: 'center' }}><span className="tri" />Cleared today <span style={{ fontWeight: 400 }}>{cleared.length}</span></summary>
        <ul style={{ margin: '10px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6, color: 'var(--ink2)' }}>
          {cleared.map((blocker) => (
            <li key={blocker.id}>{blocker.title} · {hm(blocker.resolvedAt ?? blocker.since)}</li>
          ))}
        </ul>
      </details>
    </main>
  );
}

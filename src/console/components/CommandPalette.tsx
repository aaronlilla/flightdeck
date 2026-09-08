import type { JSX } from 'react';

import type { JournalEntry, Lane } from '../../shared/console-model.js';
import type { View } from '../store.js';

export interface PaletteItem {
  kind: 'lane' | 'journal' | 'view';
  title: string;
  sub: string;
  go: () => void;
}

const VIEW_LABELS: [View, string][] = [
  ['board', 'Board'],
  ['queue', 'Queue'],
  ['settings', 'Settings'],
  ['review', 'Flight review'],
];

export function buildPaletteItems(
  query: string,
  lanes: Lane[],
  journal: JournalEntry[],
  onOpenLane: (id: string) => void,
  onNav: (view: View) => void,
  onOpenJournal: (jid: string) => void,
): PaletteItem[] {
  const q = query.trim().toLowerCase();
  const items: PaletteItem[] = [];
  // Per-category caps apply before the categories are combined: 6 lanes, the last
  // 3 journal matches, both ahead of any overall limit -- otherwise a broad query
  // can flood the list with lanes and crowd out journal and view results.
  // H2.6: the query matches the ticket key and the title, never the run id -- a
  // run id search would surface exactly the string the board is built to hide.
  const laneMatches = lanes
    .filter((lane) => !q || (lane.ticket ?? '').toLowerCase().includes(q) || (lane.title ?? '').toLowerCase().includes(q))
    .slice(0, 6);
  for (const lane of laneMatches) {
    items.push({ kind: 'lane', title: lane.ticket ?? lane.title ?? lane.id, sub: `${lane.state} · ${lane.stepText}`, go: () => onOpenLane(lane.id) });
  }
  const journalMatches = journal
    .filter((j) => !q || j.jid.toLowerCase().includes(q) || j.text.toLowerCase().includes(q))
    .slice(-3);
  for (const j of journalMatches) {
    items.push({ kind: 'journal', title: j.jid, sub: j.text, go: () => onOpenJournal(j.jid) });
  }
  for (const [view, label] of VIEW_LABELS) {
    if (!q || label.toLowerCase().includes(q)) items.push({ kind: 'view', title: label, sub: 'switch view', go: () => onNav(view) });
  }
  return items.slice(0, 20);
}

export interface CommandPaletteProps {
  query: string;
  items: PaletteItem[];
  onQueryChange: (q: string) => void;
  onClose: () => void;
}

/** ⌘K palette: lanes, journal ids, views. Enter opens first match, Esc closes. */
export function CommandPalette({ query, items, onQueryChange, onClose }: CommandPaletteProps): JSX.Element {
  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 30, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: 120, background: 'color-mix(in srgb,var(--bg) 40%,transparent)' }}
      onClick={onClose}
    >
      <div className="plate" data-testid="command-palette" style={{ width: 560, borderColor: 'var(--line2)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ background: 'var(--well)', borderRadius: '4px 4px 0 0', padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center', boxShadow: 'inset 0 2px 5px rgba(0,0,0,.6)' }}>
          <span className="m" style={{ color: '#636b58' }}>⌘K</span>
          <input
            className="inp m" style={{ fontSize: 13 }} placeholder="lane, ticket, journal id, view…"
            value={query} autoFocus
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && items[0]) { items[0].go(); onClose(); }
            }}
          />
        </div>
        <div style={{ padding: '6px 0', maxHeight: 360, overflow: 'auto' }}>
          {items.map((p, i) => (
            <div
              key={`${p.kind}-${p.title}-${i}`}
              style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '8px 14px', cursor: 'pointer', background: i === 0 ? 'var(--panel2)' : 'transparent' }}
              onClick={() => { p.go(); onClose(); }}
            >
              <span className="chip" style={{ width: 52, textAlign: 'center' }}>{p.kind}</span>
              <span className="m" style={{ fontSize: 12, fontWeight: 700 }}>{p.title}</span>
              <span className="m" style={{ fontSize: '10.5px', color: 'var(--ink2)', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.sub}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

import type { JSX } from 'react';

import type { JournalEntry, Lane } from '../../shared/console-model.js';
import type { View } from '../store.js';

export interface PaletteItem {
  kind: 'lane' | 'journal' | 'view';
  title: string;
  sub: string;
  go: () => void;
}

export function buildPaletteItems(
  query: string,
  lanes: Lane[],
  journal: JournalEntry[],
  onOpenLane: (id: string) => void,
  onNav: (view: View) => void,
): PaletteItem[] {
  const q = query.trim().toLowerCase();
  const items: PaletteItem[] = [];
  for (const lane of lanes) {
    if (!q || lane.id.toLowerCase().includes(q)) {
      items.push({ kind: 'lane', title: lane.id, sub: `${lane.state} · ${lane.repo ?? ''}`, go: () => onOpenLane(lane.id) });
    }
  }
  for (const j of journal) {
    if (!q || j.jid.toLowerCase().includes(q) || j.text.toLowerCase().includes(q)) {
      items.push({ kind: 'journal', title: j.jid, sub: j.text, go: () => undefined });
    }
  }
  for (const view of ['board', 'settings', 'review'] as View[]) {
    if (!q || view.includes(q)) items.push({ kind: 'view', title: view, sub: 'switch view', go: () => onNav(view) });
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
            <div key={`${p.kind}-${p.title}-${i}`} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '8px 14px', cursor: 'pointer' }} onClick={() => { p.go(); onClose(); }}>
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

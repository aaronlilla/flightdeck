/**
 * `ActivityDrawer` (W5): the rail's own machinery -- the system-chip `event`/`activity`
 * rows a run's tool calls and background writes generate -- lives here instead of
 * sitting in the conversation thread alongside what an operator actually said and
 * asked. Closed by default, badged with the row count; opening it collapses repeated
 * rows (the same text seen more than once) into one line with a count and the latest
 * time, so a stuck-session trip that re-fires the same row for an hour still reads as
 * one line, not a wall of them.
 */
import type { JSX } from 'react';
import { useState } from 'react';

import { hm } from '../freshness.js';
import type { Message } from '../../shared/console-model.js';

export interface ActivityDrawerProps {
  rows: Message[];
}

interface CollapsedLine {
  text: string;
  count: number;
  latestTs: number;
}

function collapseRows(rows: Message[]): CollapsedLine[] {
  const byText = new Map<string, CollapsedLine>();
  const order: string[] = [];
  for (const row of rows) {
    const existing = byText.get(row.text);
    if (existing) {
      existing.count += 1;
      if (row.ts > existing.latestTs) existing.latestTs = row.ts;
    } else {
      byText.set(row.text, { text: row.text, count: 1, latestTs: row.ts });
      order.push(row.text);
    }
  }
  return order.map((text) => byText.get(text)!).sort((a, b) => a.latestTs - b.latestTs);
}

export function ActivityDrawer({ rows }: ActivityDrawerProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  const lines = collapseRows(rows);
  return (
    <div data-testid="activity-drawer" style={{ border: '1px solid var(--line2)', borderRadius: 4 }}>
      <button
        type="button" data-testid="activity-drawer-toggle" onClick={() => setOpen((o) => !o)}
        className="lbl"
        style={{
          width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '6px 10px', background: 'none', border: 'none', color: 'var(--ink2)', cursor: 'pointer',
          fontSize: 'var(--fs-meta)',
        }}
      >
        <span>Activity</span>
        <span className="chip" data-testid="activity-drawer-badge">{rows.length}</span>
      </button>
      {open ? (
        <div data-testid="activity-drawer-body" style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '0 10px 8px' }}>
          {lines.map((line) => (
            <div key={line.text} className="m" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)', overflowWrap: 'anywhere' }}>
              {line.text}{line.count > 1 ? ` (×${line.count})` : ''} · {hm(line.latestTs)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

import type { JSX } from 'react';

import type { JournalEntry } from '../../shared/console-model.js';

export interface JournalSheetProps {
  rows: JournalEntry[];
  run?: string;
  onClose: () => void;
  onUndo: (jid: string) => void;
}

/** Journal sheet: jid · time · text · actor · undo, undone entries strike through. */
export function JournalSheet({ rows, run, onClose, onUndo }: JournalSheetProps): JSX.Element {
  return (
    <div className="plate" data-testid="journal-sheet" style={{ width: 'min(1060px, calc(100vw - 48px))', minWidth: 'min(760px, calc(100vw - 48px))', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto', boxSizing: 'border-box' }}>
      <div className="lbl" style={{ padding: '7px 20px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--line)' }}>
        <span>Journal · {run ?? 'all entries'}</span>
        <span style={{ cursor: 'pointer' }} onClick={onClose}>esc ✕</span>
      </div>
      <div style={{ padding: '12px 0' }}>
        {rows.map((j) => (
          <div
            key={j.jid} className="m"
            style={{ display: 'grid', gridTemplateColumns: '80px 70px 1fr 110px 60px', gap: 12, padding: '8px 20px', borderBottom: '1px solid var(--line)', fontSize: 11, alignItems: 'center', textDecoration: j.undone ? 'line-through' : 'none' }}
          >
            <b>{j.jid}</b>
            <span style={{ color: 'var(--ink3)' }}>{new Date(j.ts).toLocaleTimeString()}</span>
            <span>{j.text}</span>
            <span style={{ color: 'var(--ink2)' }}>{j.actor}</span>
            {j.undoable && !j.undone ? <a style={{ fontWeight: 600, textAlign: 'right' }} onClick={() => onUndo(j.jid)}>undo</a> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

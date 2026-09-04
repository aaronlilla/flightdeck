import type { JSX } from 'react';
import type { InboxEntry } from '../types.js';
import { InboxCard } from './InboxCard.js';

export interface InboxRailProps {
  open: InboxEntry[];
  onAnswer: (key: string, answer: string) => Promise<void>;
}

export function InboxRail({ open, onAnswer }: InboxRailProps): JSX.Element {
  return (
    <aside className="inbox-rail" aria-label="inbox">
      <div className="inbox-rail__head">
        <h2 className="inbox-rail__title">Inbox</h2>
        <span className="pill">{open.length}</span>
      </div>
      {open.length === 0 ? (
        <p className="inbox-empty">Nothing waiting on you.</p>
      ) : (
        open.map((entry) => <InboxCard key={entry.key} entry={entry} onAnswer={onAnswer} />)
      )}
    </aside>
  );
}

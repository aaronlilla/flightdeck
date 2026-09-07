import type { JSX } from 'react';
import { useState } from 'react';

import type { QueueItem, QueueItemState, QueueSource } from '../../shared/console-model.js';

export interface QueueViewProps {
  items: QueueItem[];
  paused: boolean;
  maxInFlight: number;
  onAdd: (source: QueueSource, input: string) => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onPause: () => void;
  onResume: () => void;
}

interface StateTaxon {
  label: string;
  color: string;
  cta: { label: string; cls: 'btnP' | 'btnA' | 'btnR' | 'btnS'; action: 'retry' | 'remove' | 'pr' | null };
}

const STATE_TAXONOMY: Record<QueueItemState, StateTaxon> = {
  queued: { label: 'QUEUED', color: 'var(--ink3)', cta: { label: 'Remove', cls: 'btnS', action: 'remove' } },
  planning: { label: 'PLANNING', color: 'var(--hand)', cta: { label: 'Remove', cls: 'btnS', action: 'remove' } },
  running: { label: 'RUNNING', color: 'var(--run)', cta: { label: 'Remove', cls: 'btnS', action: 'remove' } },
  parked: { label: 'PARKED', color: 'var(--park)', cta: { label: 'Retry →', cls: 'btnA', action: 'retry' } },
  review: { label: 'REVIEW', color: 'var(--merge)', cta: { label: 'Open PR →', cls: 'btnP', action: 'pr' } },
  failed: { label: 'FAILED', color: 'var(--block)', cta: { label: 'Retry →', cls: 'btnR', action: 'retry' } },
  done: { label: 'DONE', color: 'var(--ink3)', cta: { label: 'Remove', cls: 'btnS', action: 'remove' } },
};

const SOURCE_LABEL: Record<QueueSource, string> = {
  ticket: 'ticket', brief: 'brief', query: 'query', backlog: 'backlog', hotfix: 'hotfix',
};

function QueueCard({ item, onRemove, onRetry }: {
  item: QueueItem; onRemove: (id: string) => void; onRetry: (id: string) => void;
}): JSX.Element {
  const taxon = STATE_TAXONOMY[item.state];
  return (
    <div className="lane" style={{ borderColor: taxon.color }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
        <a className="m" style={{ fontSize: 13, fontWeight: 700 }}>{item.ticket ?? item.id}</a>
        <span className="chip">{SOURCE_LABEL[item.source]}</span>
      </div>
      <div className="lbl" style={{ color: taxon.color }}>{taxon.label}</div>
      <div className="m" style={{ fontSize: 11.5, color: 'var(--ink2)', minHeight: 32, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {item.reason ?? item.repo ?? item.input}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, borderTop: '1px solid var(--line)', paddingTop: 7 }}>
        {item.state === 'review' && item.pr ? (
          <a href={item.pr.url} target="_blank" rel="noopener noreferrer" className="btnP" style={{ padding: '7px 9px', fontSize: 9.5, width: '100%', textAlign: 'center' }}>
            Open PR #{item.pr.no} →
          </a>
        ) : (
          <span
            className={taxon.cta.cls}
            style={{ padding: '7px 9px', fontSize: 9.5, width: '100%', textAlign: 'center' }}
            onClick={() => (taxon.cta.action === 'retry' ? onRetry(item.id) : taxon.cta.action === 'remove' ? onRemove(item.id) : undefined)}
          >
            {taxon.cta.label}
          </span>
        )}
      </div>
    </div>
  );
}

const SOURCE_PLACEHOLDER: Record<QueueSource, string> = {
  ticket: 'BB-123',
  brief: '# Goal: ...',
  query: 'sprint = 42 or "epic link" = BB-1',
  backlog: 'project = BB and status = Backlog',
  hotfix: 'what\'s broken in production right now',
};

/** A.5: two quick-fill chips that build the query source's own JQL, rather than
 *  requiring an operator to remember `sprint in openSprints()` by hand. */
const QUERY_TEMPLATES: { label: string; jql: string }[] = [
  { label: 'this sprint', jql: 'sprint in openSprints()' },
  { label: 'epic…', jql: 'parent = KEY' },
];

function AddWork({ onAdd }: { onAdd: (source: QueueSource, input: string) => void }): JSX.Element {
  const [source, setSource] = useState<QueueSource>('ticket');
  const [input, setInput] = useState('');
  const submit = (): void => {
    if (!input.trim()) return;
    onAdd(source, input);
    setInput('');
  };
  return (
    <div className="plate" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {(['ticket', 'brief', 'query', 'backlog', 'hotfix'] as const).map((s) => (
          <span key={s} className={`chip chipB ${source === s ? 'chipOn' : ''}`} onClick={() => setSource(s)}>
            {SOURCE_LABEL[s]}
          </span>
        ))}
      </div>
      {source === 'query' ? (
        <div style={{ display: 'flex', gap: 8 }}>
          {QUERY_TEMPLATES.map((t) => (
            <span key={t.label} className="chip" style={{ cursor: 'pointer' }} onClick={() => setInput(t.jql)}>
              {t.label}
            </span>
          ))}
        </div>
      ) : null}
      {source === 'hotfix' ? (
        <div className="m" style={{ fontSize: 10.5, color: 'var(--ink3)' }}>
          A hotfix ships to dev on Merge and to production only on a separate Promote click.
        </div>
      ) : null}
      <div style={{ background: 'var(--well)', boxShadow: 'inset 0 2px 5px rgba(0,0,0,.6)', borderRadius: 3, padding: '8px 10px', display: 'flex', gap: 8 }}>
        {source === 'brief' || source === 'hotfix' ? (
          <textarea
            className="inp m" style={{ fontSize: 11.5, minHeight: 70, resize: 'vertical' }}
            placeholder={SOURCE_PLACEHOLDER[source]} value={input} onChange={(e) => setInput(e.target.value)}
          />
        ) : (
          <input
            className="inp m" style={{ fontSize: 12 }} placeholder={SOURCE_PLACEHOLDER[source]} value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
        )}
        <span className="btnP" style={{ padding: '5px 10px', fontSize: 9.5, alignSelf: 'flex-end' }} onClick={submit}>Add ⏎</span>
      </div>
    </div>
  );
}

/** The queue view: an add-work plate, then every item as a card in the board's own
 *  `.lane` shape, grouped by nothing but state color -- the same flat grid `LanesGrid`
 *  already uses for the run board. */
export function QueueView(props: QueueViewProps): JSX.Element {
  const { items, paused, maxInFlight, onAdd, onRemove, onRetry, onPause, onResume } = props;
  const inFlight = items.filter((i) => i.state === 'planning' || i.state === 'running').length;

  return (
    <div className="scroll" style={{ flex: 1, padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid var(--line2)', paddingBottom: 12 }}>
        <span className="lbl">Queue · {items.length} item{items.length === 1 ? '' : 's'}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="m" style={{ fontSize: 11, color: 'var(--ink2)' }}>{inFlight} / {maxInFlight} in flight</span>
          {paused ? (
            <>
              <span className="chip" style={{ color: 'var(--park)', borderColor: 'var(--park)' }}>paused</span>
              <span className="btnP" style={{ padding: '6px 10px', fontSize: 9.5 }} onClick={onResume}>Resume queue</span>
            </>
          ) : (
            <span className="btnS" style={{ padding: '6px 10px', fontSize: 9.5 }} onClick={onPause}>Pause queue</span>
          )}
        </div>
      </div>

      <AddWork onAdd={onAdd} />

      {items.length === 0 ? (
        <div className="m" style={{ fontSize: 12, color: 'var(--ink3)', padding: 40, textAlign: 'center' }}>
          nothing queued -- add a ticket, a brief, a query or a backlog filter above
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(215px,1fr))', gap: 10 }}>
          {items.map((item) => (
            <QueueCard key={item.id} item={item} onRemove={onRemove} onRetry={onRetry} />
          ))}
        </div>
      )}
    </div>
  );
}

import type { JSX } from 'react';
import { useRef, useState } from 'react';

import { actionable } from '../keyboard-actionable.js';
import type { QueueItem, QueueItemState, QueueSource } from '../../shared/console-model.js';

export interface QueueViewProps {
  items: QueueItem[];
  paused: boolean;
  /** D2.3: set when the worker itself paused the queue (three consecutive tick
   *  errors), rather than an operator's own Pause click -- undefined or null means
   *  `paused` was an operator's own doing, so the header shows the plain "paused"
   *  chip it always has. */
  pauseReason?: string | null;
  maxInFlight: number;
  onAdd: (source: QueueSource, input: string) => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onPause: () => void;
  onResume: () => void;
  /** A.7: Merge and Promote are optional -- a caller that hasn't wired them yet still
   *  gets a working board, just without those two buttons on a review/done card. */
  onMerge?: (id: string) => void;
  onPromote?: (id: string, version: string, message: string) => void;
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

function QueueCard({ item, onRemove, onRetry, onMerge, onPromote }: {
  item: QueueItem; onRemove: (id: string) => void; onRetry: (id: string) => void;
  onMerge?: (id: string) => void; onPromote?: (id: string, version: string, message: string) => void;
}): JSX.Element {
  const taxon = STATE_TAXONOMY[item.state];
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoteVersion, setPromoteVersion] = useState('');
  const [promoteMessage, setPromoteMessage] = useState('');
  // Sweep #5: the board's own Merge asks first (App.tsx's pendingConfirm); a queue
  // card's Merge fired straight away. Kept as inline state here rather than routed
  // through the rail's confirm card, since a queue card's own outcome is meant to
  // show on the Queue tab itself (sweep #3), not require a look at the rail.
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  return (
    <div className="lane" style={{ borderColor: taxon.color }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <a className="m" style={{ fontSize: 13, fontWeight: 700 }}>{item.ticket ?? item.id}</a>
        <div style={{ display: 'flex', gap: 6 }}>
          {/* D2.3: A.1's fix round -- the round count and the findings it is retrying
              against, the latter carried in `reason` the same way a parked/failed
              item already shows its own reason below. */}
          {item.fixRoundsUsed ? (
            <span className="chip" style={{ borderColor: 'var(--park)', color: 'var(--park)' }}>fix round {item.fixRoundsUsed}</span>
          ) : null}
          <span className="chip">{SOURCE_LABEL[item.source]}</span>
        </div>
      </div>
      <div className="lbl" style={{ color: taxon.color }}>{taxon.label}</div>
      <div className="m" style={{ fontSize: 11.5, color: 'var(--ink2)', minHeight: 32, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {item.reason ?? item.repo ?? item.input}
      </div>
      {item.state === 'review' && item.councilNotes && item.councilNotes.length > 0 ? (
        <div className="m" style={{ fontSize: 9.5, color: 'var(--ink3)' }}>
          council notes: {item.councilNotes.join('; ')}
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, borderTop: '1px solid var(--line)', paddingTop: 7 }}>
        {item.state === 'review' && item.pr ? (
          <>
            <a href={item.pr.url} target="_blank" rel="noopener noreferrer" className="btnP" style={{ padding: '7px 9px', fontSize: 9.5, width: '100%', textAlign: 'center' }}>
              Open PR #{item.pr.no} →
            </a>
            <div className="m" style={{ fontSize: 9.5, color: 'var(--ink3)', textAlign: 'center' }}>
              {item.pr.files} file{item.pr.files === 1 ? '' : 's'}, +{item.pr.add}/-{item.pr.del}
            </div>
            {onMerge && mergeConfirmOpen ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <span
                  className="btnR" style={{ padding: '7px 9px', fontSize: 9.5, flex: 1, textAlign: 'center' }}
                  {...actionable(() => { setMergeConfirmOpen(false); onMerge(item.id); })}
                >
                  Confirm merge
                </span>
                <span
                  className="btnS" style={{ padding: '7px 9px', fontSize: 9.5, flex: 1, textAlign: 'center' }}
                  {...actionable(() => setMergeConfirmOpen(false))}
                >
                  Cancel
                </span>
              </div>
            ) : onMerge ? (
              <span className="btnA" style={{ padding: '7px 9px', fontSize: 9.5, width: '100%', textAlign: 'center' }} {...actionable(() => setMergeConfirmOpen(true))}>
                Merge
              </span>
            ) : null}
          </>
        ) : item.state === 'done' && item.source === 'hotfix' && item.promotedAt ? (
          <div className="m" style={{ fontSize: 9.5, color: 'var(--ink3)', textAlign: 'center' }}>
            promoted {item.promotedVersion}
          </div>
        ) : item.state === 'done' && item.source === 'hotfix' && onPromote ? (
          promoteOpen ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <input
                className="inp m" style={{ fontSize: 10.5 }} placeholder="version, e.g. 1.4.2"
                value={promoteVersion} onChange={(e) => setPromoteVersion(e.target.value)}
              />
              <input
                className="inp m" style={{ fontSize: 10.5 }} placeholder="one-line release message"
                value={promoteMessage} onChange={(e) => setPromoteMessage(e.target.value)}
              />
              <span
                className="btnA"
                style={{ padding: '7px 9px', fontSize: 9.5, width: '100%', textAlign: 'center', opacity: promoteVersion.trim() && promoteMessage.trim() ? 1 : 0.5 }}
                {...actionable(() => {
                  if (!promoteVersion.trim() || !promoteMessage.trim()) return;
                  onPromote(item.id, promoteVersion.trim(), promoteMessage.trim());
                })}
              >
                Confirm promote
              </span>
            </div>
          ) : (
            <span className="btnA" style={{ padding: '7px 9px', fontSize: 9.5, width: '100%', textAlign: 'center' }} {...actionable(() => setPromoteOpen(true))}>
              Promote
            </span>
          )
        ) : (
          <span
            className={taxon.cta.cls}
            style={{ padding: '7px 9px', fontSize: 9.5, width: '100%', textAlign: 'center' }}
            {...actionable(() => (taxon.cta.action === 'retry' ? onRetry(item.id) : taxon.cta.action === 'remove' ? onRemove(item.id) : undefined))}
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

// Sweep #14: a query template can carry a placeholder token the operator must type
// over (the epic chip's `parent = KEY`) -- never a literal value Add is allowed to
// submit as though it named a real epic.
const TEMPLATE_PLACEHOLDER = 'KEY';
const PLACEHOLDER_WORD = new RegExp(`\\b${TEMPLATE_PLACEHOLDER}\\b`);

function AddWork({ onAdd }: { onAdd: (source: QueueSource, input: string) => void }): JSX.Element {
  const [source, setSource] = useState<QueueSource>('ticket');
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const holdsPlaceholder = source === 'query' && PLACEHOLDER_WORD.test(input);
  const submit = (): void => {
    if (!input.trim() || holdsPlaceholder) return;
    onAdd(source, input);
    setInput('');
  };
  const fillTemplate = (jql: string): void => {
    setInput(jql);
    const idx = jql.indexOf(TEMPLATE_PLACEHOLDER);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      if (idx >= 0) el.setSelectionRange(idx, idx + TEMPLATE_PLACEHOLDER.length);
    });
  };
  return (
    <div className="plate" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {(['ticket', 'brief', 'query', 'backlog', 'hotfix'] as const).map((s) => (
          <span key={s} className={`chip chipB ${source === s ? 'chipOn' : ''}`} {...actionable(() => setSource(s))}>
            {SOURCE_LABEL[s]}
          </span>
        ))}
      </div>
      {source === 'query' ? (
        <div style={{ display: 'flex', gap: 8 }}>
          {QUERY_TEMPLATES.map((t) => (
            <span key={t.label} className="chip" style={{ cursor: 'pointer' }} {...actionable(() => fillTemplate(t.jql))}>
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
            ref={inputRef}
            className="inp m" style={{ fontSize: 12 }} placeholder={SOURCE_PLACEHOLDER[source]} value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
        )}
        <span
          className="btnP"
          style={{ padding: '5px 10px', fontSize: 9.5, alignSelf: 'flex-end', opacity: holdsPlaceholder ? 0.5 : 1 }}
          title={holdsPlaceholder ? 'type over the KEY placeholder first' : undefined}
          {...actionable(submit)}
        >
          Add ⏎
        </span>
      </div>
    </div>
  );
}

/** The queue view: an add-work plate, then every item as a card in the board's own
 *  `.lane` shape, grouped by nothing but state color -- the same flat grid `LanesGrid`
 *  already uses for the run board. */
export function QueueView(props: QueueViewProps): JSX.Element {
  const { items, paused, pauseReason, maxInFlight, onAdd, onRemove, onRetry, onPause, onResume, onMerge, onPromote } = props;
  const inFlight = items.filter((i) => i.state === 'planning' || i.state === 'running').length;
  // Sweep #18: the nav badge counts parked+failed while this header counted every
  // item, so "Queue 8" next to "Queue · 28 items" read as two disagreeing numbers
  // rather than one total and one subset of it.
  const needsAttention = items.filter((i) => i.state === 'parked' || i.state === 'failed').length;

  return (
    <div className="scroll" style={{ flex: 1, padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid var(--line2)', paddingBottom: 12 }}>
        <span className="lbl">
          Queue · {items.length} item{items.length === 1 ? '' : 's'}
          {needsAttention > 0 ? `, ${needsAttention} need${needsAttention === 1 ? 's' : ''} attention` : ''}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="m" style={{ fontSize: 11, color: 'var(--ink2)' }}>{inFlight} / {maxInFlight} in flight</span>
          {paused ? (
            <>
              <span className="chip" style={{ color: 'var(--park)', borderColor: 'var(--park)' }}>
                {pauseReason ? `paused — ${pauseReason}` : 'paused'}
              </span>
              <span className="btnP" style={{ padding: '6px 10px', fontSize: 9.5 }} {...actionable(onResume)}>Resume queue</span>
            </>
          ) : (
            <span className="btnS" style={{ padding: '6px 10px', fontSize: 9.5 }} {...actionable(onPause)}>Pause queue</span>
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
            <QueueCard key={item.id} item={item} onRemove={onRemove} onRetry={onRetry} onMerge={onMerge} onPromote={onPromote} />
          ))}
        </div>
      )}
    </div>
  );
}

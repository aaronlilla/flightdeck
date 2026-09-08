import type { JSX } from 'react';
import { ACTIONS, useAction } from '../actions.js';
import type { ActionOutcome } from '../store.js';
import { ActionButton, ActionOutcomeView } from './ActionButton.js';
import { useRef, useState } from 'react';

import { BOARD_GRID_COLUMNS, CARD_GAP_PX } from '../grid.js';
import { actionable } from '../keyboard-actionable.js';
import { Linkify } from './Linkify.js';
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
  /** The rail is not on this view, so every outcome here is also shown as a toast. */
  onToast?: (text: string, ok: boolean) => void;
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

const NEWLINES = /\r?\n/;
const HEADING = /^#[ \t]+/;
const HEADING_ANY = /^#{1,6}\s/;

/** The line under the title. A parked or failed item explains itself; a routed item
 *  names its repository; anything else gets the first sentence of its own brief. Never
 *  `input`: a brief item carries its whole markdown text there, and printing it is what
 *  made these cards unreadable. */
function cardBody(item: QueueItem): string | null {
  if ((item.state === 'parked' || item.state === 'failed') && item.reason) return item.reason;
  if (item.repo && item.repo !== 'unknown') return item.repo;
  if (item.source !== 'brief' && item.source !== 'hotfix') return null;
  const lines = item.input.split(NEWLINES);
  const headingAt = lines.findIndex((line) => HEADING.test(line));
  for (const raw of headingAt >= 0 ? lines.slice(headingAt + 1) : lines) {
    const line = raw.trim();
    if (!line || HEADING_ANY.test(line)) continue;
    if (item.title && line.startsWith(item.title.slice(0, 24))) continue;
    return line.length > 200 ? `${line.slice(0, 200).trimEnd()}…` : line;
  }
  return null;
}

function QueueCard({ item, onToast }: { item: QueueItem; onToast: (outcome: ActionOutcome) => void }): JSX.Element {
  const taxon = STATE_TAXONOMY[item.state];
  const title = item.title ?? item.ticket ?? item.id;
  const body = cardBody(item);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoteVersion, setPromoteVersion] = useState('');
  const [promoteMessage, setPromoteMessage] = useState('');
  // Merge and Promote are irreversible: the catalog action shows the server's own
  // confirm card on the card itself, and nothing merges until that token goes back.
  return (
    <div className="lane" style={{ borderColor: taxon.color }}>
      {/* The title leads: a brief's own heading, a ticket key, or the id -- never the
          brief text, which is what `input` holds and what this card used to print. */}
      <div
        data-testid="queue-card-title" title={title}
        style={{
          fontSize: 'var(--fs-title)', lineHeight: '22px', fontWeight: 700, color: 'var(--ink)',
          overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span className="lbl" style={{ color: taxon.color }}>{taxon.label}</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {/* The key or id still shows when the title is something else, so the card a
              person is reading is still the card they can name on the command line. */}
          {item.title ? <span className="chip">{item.ticket ?? item.id}</span> : null}
          {/* D2.3: A.1's fix round -- the round count and the findings it is retrying
              against, the latter carried in `reason` the same way a parked/failed
              item already shows its own reason below. */}
          {item.fixRoundsUsed ? (
            <span className="chip" style={{ borderColor: 'var(--park)', color: 'var(--park)' }}>fix round {item.fixRoundsUsed}</span>
          ) : null}
          <span className="chip">{SOURCE_LABEL[item.source]}</span>
        </div>
      </div>
      <div
        className="m" data-testid="queue-card-body"
        style={{
          fontSize: 'var(--fs-body)', lineHeight: '20px', color: 'var(--ink2)', minHeight: 40,
          overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}
      >
        {body ? <Linkify text={body} repo={item.repo} /> : null}
      </div>
      {item.state === 'review' && item.councilNotes && item.councilNotes.length > 0 ? (
        <div className="m" style={{ fontSize: 'var(--fs-ui)', color: 'var(--ink3)' }}>
          council notes: <Linkify text={item.councilNotes.join('; ')} repo={item.repo} />
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, borderTop: '1px solid var(--line)', paddingTop: 7 }}>
        {item.state === 'review' && item.pr ? (
          <>
            <a href={item.pr.url} target="_blank" rel="noopener noreferrer" className="btnP" style={{ padding: '7px 9px', fontSize: 'var(--fs-ui)', width: '100%', textAlign: 'center' }}>
              Open PR #{item.pr.no} →
            </a>
            <div className="m" style={{ fontSize: 'var(--fs-ui)', color: 'var(--ink3)', textAlign: 'center' }}>
              {item.pr.files} file{item.pr.files === 1 ? '' : 's'}, +{item.pr.add}/-{item.pr.del}
            </div>
            <ActionButton
              spec={ACTIONS.mergeQueueItem} args={[item.id]} className="btnA"
              style={{ padding: '7px 9px', fontSize: 'var(--fs-ui)', width: '100%', textAlign: 'center', boxSizing: 'border-box' }}
              busy="Merging…" onOutcome={onToast}
            >
              Merge
            </ActionButton>
          </>
        ) : item.state === 'done' && item.source === 'hotfix' && item.promotedAt ? (
          <div className="m" style={{ fontSize: 'var(--fs-ui)', color: 'var(--ink3)', textAlign: 'center' }}>
            promoted {item.promotedVersion}
          </div>
        ) : item.state === 'done' && item.source === 'hotfix' ? (
          promoteOpen ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <input
                className="inp m" style={{ fontSize: 'var(--fs-ui)' }} placeholder="version, e.g. 1.4.2"
                value={promoteVersion} onChange={(e) => setPromoteVersion(e.target.value)}
              />
              <input
                className="inp m" style={{ fontSize: 'var(--fs-ui)' }} placeholder="one-line release message"
                value={promoteMessage} onChange={(e) => setPromoteMessage(e.target.value)}
              />
              <ActionButton
                spec={ACTIONS.promoteQueueItem} args={[item.id, promoteVersion.trim(), promoteMessage.trim()]} actionRef={item.id}
                className="btnA" disabled={!promoteVersion.trim() || !promoteMessage.trim()}
                style={{ padding: '7px 9px', fontSize: 'var(--fs-ui)', width: '100%', textAlign: 'center', boxSizing: 'border-box' }}
                busy="Promoting…" onOutcome={onToast}
              >
                Promote {promoteVersion.trim() || '…'}
              </ActionButton>
            </div>
          ) : (
            <span className="btnA" style={{ padding: '7px 9px', fontSize: 'var(--fs-ui)', width: '100%', textAlign: 'center' }} {...actionable(() => setPromoteOpen(true))}>
              Promote
            </span>
          )
        ) : (
          taxon.cta.action === 'retry' ? (
            <ActionButton
              spec={ACTIONS.retryQueueItem} args={[item.id]} className={taxon.cta.cls}
              style={{ padding: '7px 9px', fontSize: 'var(--fs-ui)', width: '100%', textAlign: 'center', boxSizing: 'border-box' }}
              busy="Retrying…" onOutcome={onToast}
            >
              {taxon.cta.label}
            </ActionButton>
          ) : taxon.cta.action === 'remove' ? (
            <ActionButton
              spec={ACTIONS.removeQueueItem} args={[item.id]} className={taxon.cta.cls}
              style={{ padding: '7px 9px', fontSize: 'var(--fs-ui)', width: '100%', textAlign: 'center', boxSizing: 'border-box' }}
              busy="Removing…" onOutcome={onToast}
            >
              {taxon.cta.label}
            </ActionButton>
          ) : (
            <span className={taxon.cta.cls} style={{ padding: '7px 9px', fontSize: 'var(--fs-ui)', width: '100%', textAlign: 'center' }}>
              {taxon.cta.label}
            </span>
          )
        )}
      </div>
    </div>
  );
}

const SOURCE_PLACEHOLDER: Record<QueueSource, string> = {
  ticket: 'BB-123',
  brief: '# Goal: ...  then a line  repo: owner/name  (or the path to a .md brief file on this machine)',
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

function AddWork({ onToast }: { onToast: (outcome: ActionOutcome) => void }): JSX.Element {
  const [source, setSource] = useState<QueueSource>('ticket');
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const holdsPlaceholder = source === 'query' && PLACEHOLDER_WORD.test(input);
  const add = useAction(ACTIONS.addToQueue, 'add-work');
  const submit = (): void => {
    if (!input.trim() || holdsPlaceholder || add.pending) return;
    const body = { source, input };
    void add.run(body).then((outcome) => {
      onToast(outcome);
      if (outcome.kind === 'done' && outcome.ok) setInput('');
    });
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
        <div className="m" style={{ fontSize: 'var(--fs-ui)', color: 'var(--ink3)' }}>
          A hotfix ships to dev on Merge and to production only on a separate Promote click.
        </div>
      ) : null}
      <div style={{ background: 'var(--well)', boxShadow: 'inset 0 2px 5px rgba(0,0,0,.6)', borderRadius: 3, padding: '8px 10px', display: 'flex', gap: 8 }}>
        {source === 'brief' || source === 'hotfix' ? (
          <textarea
            className="inp m" style={{ fontSize: 'var(--fs-body)', minHeight: 70, resize: 'vertical' }}
            placeholder={SOURCE_PLACEHOLDER[source]} value={input} onChange={(e) => setInput(e.target.value)}
          />
        ) : (
          <input
            ref={inputRef}
            className="inp m" style={{ fontSize: 'var(--fs-ui)' }} placeholder={SOURCE_PLACEHOLDER[source]} value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
        )}
        <span
          className="btnP"
          style={{ padding: '5px 10px', fontSize: 'var(--fs-ui)', alignSelf: 'flex-end', opacity: holdsPlaceholder || add.pending ? 0.5 : 1 }}
          title={holdsPlaceholder ? 'type over the KEY placeholder first' : undefined}
          aria-disabled={holdsPlaceholder || add.pending} aria-busy={add.pending}
          data-testid="action-addToQueue-add-work" data-pending={add.pending ? 'true' : 'false'}
          {...actionable(submit)}
        >
          {add.pending ? 'Adding…' : 'Add ⏎'}
        </span>
      </div>
      <ActionOutcomeView
        result={add.result} pending={add.pending} specId="addToQueue" actionRef="add-work"
        onConfirm={() => undefined} onDismiss={add.dismiss} onClear={add.clear}
      />
    </div>
  );
}

/** The queue view: an add-work plate, then every item as a card in the board's own
 *  `.lane` shape, grouped by nothing but state color -- the same flat grid `LanesGrid`
 *  already uses for the run board. */
export function QueueView(props: QueueViewProps): JSX.Element {
  const { items, paused, pauseReason, maxInFlight, onToast } = props;
  const toast = (outcome: ActionOutcome): void => {
    if (outcome.kind === 'done') onToast?.(outcome.text, outcome.ok);
  };
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
          <span className="m" style={{ fontSize: 'var(--fs-body)', color: 'var(--ink2)' }}>{inFlight} / {maxInFlight} in flight</span>
          {paused ? (
            <>
              <span className="chip" style={{ color: 'var(--park)', borderColor: 'var(--park)' }}>
                {pauseReason ? `paused — ${pauseReason}` : 'paused'}
              </span>
              <ActionButton spec={ACTIONS.resumeQueue} args={[]} actionRef="queue" className="btnP" style={{ padding: '6px 10px', fontSize: 'var(--fs-ui)' }} busy="Resuming…" onOutcome={toast}>Resume queue</ActionButton>
            </>
          ) : (
            <ActionButton spec={ACTIONS.pauseQueue} args={[]} actionRef="queue" className="btnS" style={{ padding: '6px 10px', fontSize: 'var(--fs-ui)' }} busy="Pausing…" onOutcome={toast}>Pause queue</ActionButton>
          )}
        </div>
      </div>

      <AddWork onToast={toast} />

      {items.length === 0 ? (
        <div className="m" style={{ fontSize: 'var(--fs-body)', color: 'var(--ink3)', padding: 40, textAlign: 'center' }}>
          nothing queued -- add a ticket, a brief, a query or a backlog filter above
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: BOARD_GRID_COLUMNS, gridAutoRows: 'auto', alignItems: 'start', gap: CARD_GAP_PX }}>
          {items.map((item) => (
            <QueueCard key={item.id} item={item} onToast={toast} />
          ))}
        </div>
      )}
    </div>
  );
}

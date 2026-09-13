import type { JSX } from 'react';

import { ACTIONS, useAction } from '../actions.js';
import type { QueueItem } from '../../shared/console-model.js';
import { queueActionLiveness } from '../actionLiveness.js';
import { useWidthStepper } from '../useWidthStepper.js';
import { Marks } from './QuestionCard.js';
import { NarratedLine } from './Narrated.js';

/**
 * `Flightdeck Console.dc.html` 1c: what runs next, in the queue's own order, with why
 * each item is where it is and when it starts, plus the width stepper. Items already
 * past the queue (running, in review, parked, failed) are listed under it with the one
 * action their state allows.
 */
export interface QueueViewProps {
  items: QueueItem[];
  paused: boolean;
  pauseReason?: string | null;
  maxInFlight: number;
  /** Lanes working right now, for the stepper's "N working · M idle" line. */
  working?: number;
  /** `?verbose=1`: the fact record under each narrated sentence. */
  verbose?: boolean;
  onToast?: (text: string, ok: boolean) => void;
}

function titleOf(item: QueueItem): string {
  return item.title ?? item.ticket ?? (item.source === 'brief' ? 'A pasted brief' : item.source === 'hotfix' ? 'A hotfix' : 'An untitled item');
}

function LaterRow({ item }: { item: QueueItem }): JSX.Element {
  const merge = useAction(ACTIONS.mergeQueueItem, item.id);
  const retry = useAction(ACTIONS.retryQueueItem, item.id);
  const state = item.state === 'review' ? 'Ready to merge' : item.state === 'parked' ? 'Parked' : item.state === 'failed' ? 'Failed' : item.state === 'planning' ? 'Planning' : item.state === 'done' ? 'Done' : 'Working';
  const action = item.state === 'review'
    ? { label: merge.pending ? 'Merging…' : (merge.result?.kind === 'confirm' ? 'Confirm merge' : 'Merge'), run: () => void (merge.result?.kind === 'confirm' ? merge.confirm() : merge.run(item.id)), kind: 'primary' }
    : item.state === 'parked' || item.state === 'failed'
      ? { label: retry.pending ? 'Retrying…' : 'Retry', run: () => void retry.run(item.id), kind: '' }
      : null;
  // The row's state moves under the button between polls: a Merge offered on something
  // already merged tells somebody to do a thing that is done (Aaron, 2026-09-12). A dead
  // action renders as its reason instead.
  const verdict = queueActionLiveness(item, item.state === 'review' ? 'merge' : 'retry');
  return (
    <div className="queue-row" style={{ display: 'grid', gridTemplateColumns: '44px minmax(0,1fr) minmax(0,1fr) 190px', gap: 18, alignItems: 'baseline', padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
      <span className="kick" style={{ fontSize: 'var(--fs-meta)' }}>{state}</span>
      <span><span className="key" style={{ marginRight: 10 }}>{item.ticket ?? ''}</span><span className="hd" data-testid="queue-card-title" style={{ fontSize: 'var(--fs-rowhead)' }}>{titleOf(item)}</span></span>
      <span style={{ color: 'var(--ink2)' }}>{item.reason ?? (item.pr ? `PR #${item.pr.no}${item.pr.draft ? ' (draft)' : ''}` : '')}</span>
      <span>{action && verdict.live
        ? <button type="button" className={`btn ${action.kind}`} onClick={action.run}>{action.label}</button>
        : action
          ? <span data-testid="queue-action-unavailable" title={verdict.live === false ? verdict.why : ''} style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>{verdict.live === false ? verdict.why : ''}</span>
          : null}</span>
    </div>
  );
}

export function QueueView({ items, paused, pauseReason, maxInFlight, working = 0, verbose }: QueueViewProps): JSX.Element {
  const width = useWidthStepper(maxInFlight);
  const next = items.filter((item) => item.state === 'queued');
  const later = items.filter((item) => item.state !== 'queued' && item.state !== 'done');
  const idle = Math.max(0, maxInFlight - working);
  return (
    <main data-testid="queue-view" className="scroll" style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '26px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 24 }}>
        <div>
          {paused ? <p className="hd" style={{ margin: 0, fontSize: 'var(--fs-rowhead)', color: 'var(--warn)' }}>{pauseReason ? `Paused · ${pauseReason}` : 'Paused'}</p> : null}
        </div>
        <div style={{ position: 'relative', border: '1px solid var(--line)', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 16 }}>
          <Marks />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <label style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink2)' }}>At once</label>
            <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>{working} working · {idle} idle</span>
          </div>
          <div className="step" data-testid="queue-width">
            <button type="button" aria-label="one fewer" onClick={width.dec}>−</button>
            <span>{width.value}</span>
            <button type="button" aria-label="one more" onClick={width.inc}>+</button>
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '44px 1fr 1fr 190px', gap: 18, padding: '0 16px 8px', borderBottom: '1px solid var(--line2)' }} className="kick">
        <span>#</span><span>Ticket</span><span>Why</span><span>Starts</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {next.map((item, index) => (
          <div key={item.id} className="queue-row" style={{ display: 'grid', gridTemplateColumns: '44px minmax(0,1fr) minmax(0,1fr) 190px', gap: 18, alignItems: 'baseline', padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
            <span className="hd" style={{ fontSize: 'var(--fs-num)', color: 'var(--ink3)', fontVariantNumeric: 'tabular-nums' }}>{index + 1}</span>
            <span><span className="key" style={{ marginRight: 10 }}>{item.ticket ?? ''}</span><span className="hd" data-testid="queue-card-title" style={{ fontSize: 'var(--fs-rowhead)' }}><NarratedLine bag={item.narration} field="title" glance={titleOf(item)} testid="queue-title" {...(verbose === undefined ? {} : { verbose })} /></span></span>
            <span style={{ color: 'var(--ink2)' }}><NarratedLine bag={item.narration} field="whyNext" glance={item.whyNext ?? ''} testid="queue-why" {...(verbose === undefined ? {} : { verbose })} /></span>
            <span style={{ color: index === 0 && !paused ? 'var(--acc)' : 'var(--ink)' }}><NarratedLine bag={item.narration} field="startsIn" glance={item.startsIn ?? ''} testid="queue-starts" {...(verbose === undefined ? {} : { verbose })} /></span>
          </div>
        ))}
        {next.length === 0 ? <p style={{ margin: '14px 16px', color: 'var(--ink2)' }}>Empty</p> : null}
      </div>
      {later.length > 0 ? (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h6 className="sec">Past the queue <span className="n">{later.length}</span></h6>
          <div style={{ display: 'flex', flexDirection: 'column' }}>{later.map((item) => <LaterRow key={item.id} item={item} />)}</div>
        </section>
      ) : null}
      {width.result?.kind === 'done' && !width.result.ok ? <p style={{ margin: 0, fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{width.result.text}</p> : null}
    </main>
  );
}

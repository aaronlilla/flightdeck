import type { JSX } from 'react';
import { useState } from 'react';

import { ACTIONS, useAction } from '../actions.js';
import type { QueueItem } from '../../shared/console-model.js';
import { queueActionLiveness } from '../actionLiveness.js';
import { WhatIsHover } from './WhatIsCard.js';
import { Linkify } from './Linkify.js';
import { useWidthStepper } from '../useWidthStepper.js';
import { Marks } from './QuestionCard.js';
import { NarratedLine } from './Narrated.js';
import { readQueueInput } from '../../shared/queueInput.js';

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
      <span>{item.ticket ? <WhatIsHover refText={item.ticket}><span className="key" style={{ marginRight: 10 }}>{item.ticket}</span></WhatIsHover> : null}<span className="hd" data-testid="queue-card-title" style={{ fontSize: 'var(--fs-rowhead)' }}>{titleOf(item)}</span></span>
      <span style={{ color: 'var(--ink2)' }}><Linkify text={item.reason ?? (item.pr ? `PR #${item.pr.no}${item.pr.draft ? ' (draft)' : ''}` : '')} repo={item.repo} /></span>
      <span>{action && verdict.live
        ? <button type="button" className={`btn ${action.kind}`} onClick={action.run}>{action.label}</button>
        : action
          ? <span data-testid="queue-action-unavailable" title={verdict.live === false ? verdict.why : ''} style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>{verdict.live === false ? verdict.why : ''}</span>
          : null}</span>
    </div>
  );
}

/**
 * The one way into the queue from the console.
 *
 * Until this existed there was none: the queue screen held a width stepper and nothing
 * else, and the only route in was typing a sentence at the rail and hoping it reached the
 * right tool. A ticket cannot be taken end to end through a console it cannot be put
 * into.
 *
 * One box rather than a kind-picker, because "is this a ticket key, a search or a brief?"
 * is a question about the plumbing and not about the work. `readQueueInput` decides, and
 * the reading is shown under the box before anything is sent, so a wrong one is a visible
 * sentence rather than a wrong row on the board.
 */
function AddToQueue(): JSX.Element {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useAction(ACTIONS.addToQueue);
  const reading = readQueueInput(text);

  async function submit(): Promise<void> {
    if (!reading) return;
    setError(null);
    const outcome = await add.run({ source: reading.source, input: reading.input });
    if (outcome.kind === 'done' && outcome.ok) {
      setText('');
      return;
    }
    setError(outcome.kind === 'done' ? outcome.text : 'that add did not go through');
  }

  return (
    <div
      data-testid="queue-add"
      style={{ position: 'relative', border: '1px solid var(--line)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <Marks />
      <label className="kick" htmlFor="queue-add-input">Add work</label>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <textarea
          id="queue-add-input" data-testid="queue-add-input" rows={2}
          placeholder="Ticket key, Jira search, or a brief"
          value={text}
          onChange={(event) => { setText(event.target.value); }}
          onKeyDown={(event) => {
            // Enter sends, since the common case is a ticket key on one line. A brief that
            // wants its own paragraphs still gets them on Shift+Enter.
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); }
          }}
          style={{ flex: '1 1 320px', minWidth: 0, resize: 'vertical', font: 'inherit', fontSize: 'var(--fs-body)', padding: '8px 10px', border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--ink)' }}
        />
        <button
          type="button" className="btn primary" data-testid="queue-add-submit"
          disabled={reading === null || add.pending}
          onClick={() => { void submit(); }}
          style={{ padding: '8px 18px' }}
        >
          {add.pending ? 'Adding…' : 'Add'}
        </button>
      </div>
      <span data-testid="queue-add-reading" style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)', minHeight: '1.2em' }}>
        {reading ? reading.says : ''}
      </span>
      {error ? (
        <span role="alert" style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{error}</span>
      ) : null}
    </div>
  );
}

/**
 * One row of what is still waiting, with the one thing a person does to a waiting item
 * that is not waiting for it: take it back out.
 *
 * There was no way to. An item added by mistake, or overtaken by events, sat there until
 * it ran -- the server has taken a remove since the queue existed and no screen offered
 * it. Removing is not reversible, so it asks first, the same two-step every other
 * irreversible control here uses.
 */
function NextRow({ item, index, paused, verbose }: {
  item: QueueItem; index: number; paused: boolean; verbose?: boolean;
}): JSX.Element {
  const remove = useAction(ACTIONS.removeQueueItem, item.id);
  const asking = remove.result?.kind === 'confirm';
  return (
    <div className="queue-row" data-testid={`queue-row-${item.id}`} style={{ display: 'grid', gridTemplateColumns: '44px minmax(0,1fr) minmax(0,1fr) 150px 100px', gap: 18, alignItems: 'baseline', padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
      <span className="hd" style={{ fontSize: 'var(--fs-num)', color: 'var(--ink3)', fontVariantNumeric: 'tabular-nums' }}>{index + 1}</span>
      <span>{item.ticket ? <WhatIsHover refText={item.ticket}><span className="key" style={{ marginRight: 10 }}>{item.ticket}</span></WhatIsHover> : null}<span className="hd" data-testid="queue-card-title" style={{ fontSize: 'var(--fs-rowhead)' }}><NarratedLine bag={item.narration} field="title" glance={titleOf(item)} testid="queue-title" {...(verbose === undefined ? {} : { verbose })} /></span></span>
      <span style={{ color: 'var(--ink2)' }}><NarratedLine bag={item.narration} field="whyNext" glance={item.whyNext ?? ''} testid="queue-why" {...(verbose === undefined ? {} : { verbose })} /></span>
      <span style={{ color: index === 0 && !paused ? 'var(--acc)' : 'var(--ink)' }}><NarratedLine bag={item.narration} field="startsIn" glance={item.startsIn ?? ''} testid="queue-starts" {...(verbose === undefined ? {} : { verbose })} /></span>
      <span>
        <button
          type="button" className={`btn ${asking ? 'warn' : 'ghost'}`}
          data-testid={`queue-remove-${item.id}`}
          disabled={remove.pending}
          onClick={() => { void (asking ? remove.confirm() : remove.run(item.id)); }}
        >
          {remove.pending ? 'Removing…' : asking ? 'Really remove' : 'Remove'}
        </button>
      </span>
    </div>
  );
}

/**
 * Stop the queue starting anything new, and start it again.
 *
 * The screen showed "Paused" as a word and gave no way to change it: pausing meant
 * finding the sentence the rail understood, and starting again meant remembering it.
 *
 * The button says what the click will do, never what is true now -- one reading "Paused"
 * beside a running queue is the ambiguity this console keeps getting wrong.
 */
function QueueRunning({ paused }: { paused: boolean }): JSX.Element {
  const pause = useAction(ACTIONS.pauseQueue);
  const resume = useAction(ACTIONS.resumeQueue);
  const busy = pause.pending || resume.pending;
  return (
    <button
      type="button" className={`btn ${paused ? 'primary' : ''}`}
      data-testid="queue-pause-toggle" aria-pressed={paused}
      disabled={busy}
      onClick={() => { void (paused ? resume.run() : pause.run()); }}
      style={{ padding: '8px 16px' }}
    >
      {busy ? 'Working…' : paused ? 'Start the queue' : 'Pause the queue'}
    </button>
  );
}

export function QueueView({ items, paused, pauseReason, maxInFlight, working = 0, verbose }: QueueViewProps): JSX.Element {
  const width = useWidthStepper(maxInFlight);
  const next = items.filter((item) => item.state === 'queued');
  const later = items.filter((item) => item.state !== 'queued' && item.state !== 'done');
  const idle = Math.max(0, maxInFlight - working);
  return (
    <main data-testid="queue-view" className="scroll" style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '26px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 24, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 360px', minWidth: 0 }}>
          {paused ? <p className="hd" style={{ margin: '0 0 10px', fontSize: 'var(--fs-rowhead)', color: 'var(--warn)' }}>{pauseReason ? `Paused · ${pauseReason}` : 'Paused'}</p> : null}
          <AddToQueue />
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
          <QueueRunning paused={paused} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '44px 1fr 1fr 150px 100px', gap: 18, padding: '0 16px 8px', borderBottom: '1px solid var(--line2)' }} className="kick">
        <span>#</span><span>Ticket</span><span>Why</span><span>Starts</span><span />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {next.map((item, index) => (
          <NextRow
            key={item.id} item={item} index={index} paused={paused}
            {...(verbose === undefined ? {} : { verbose })}
          />
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

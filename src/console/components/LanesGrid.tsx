import type { JSX } from 'react';

import { hm } from '../freshness.js';
import { blockerFor, boardCta, boardStateWord, durationWords, groupLanesByTicket, idleReason, IDLE_STATE, laneHeadline, type BoardCommand } from '../laneVM.js';
import type { Blocker, Lane, QueueItem } from '../../shared/console-model.js';
import { LaneGroupTile } from './LaneGroupTile.js';
import { Marks } from './QuestionCard.js';
import { ACTIONS, useAction } from '../actions.js';
import { busyLabelFor, useCommandPending } from '../commandPending.js';

/**
 * `FD Board.dc.html`: the running grid (one card per active lane, dashed idle cards up
 * to the queue's width), then Needs you, Waiting for merge, Blocked or parked, and
 * Finished today. Every button calls the route its state names through `onCommand`.
 */
export interface LanesGridProps {
  lanes: Lane[];
  blockers: Blocker[];
  queue: { items: QueueItem[]; paused: boolean; pauseReason: string | null; maxInFlight: number; on: boolean };
  now: number;
  onOpen: (id: string) => void;
  onCommand: (id: string, cmd: BoardCommand) => void;
  /** A Needs-you answer, or any free text for a lane: `answer <key> <text>`. */
  onLaneCommand: (id: string, command: string) => void;
  onQueue: () => void;
}

const FINISHED_STATES = new Set(['merged', 'killed']);

function isActive(lane: Lane): boolean {
  return lane.retiredAt === null && !FINISHED_STATES.has(lane.state);
}

function startOfToday(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function mergeLine(lane: Lane): string {
  const pr = lane.pr;
  if (!pr) return 'ready';
  const checks = pr.checks === 'success' ? 'checks passed' : pr.checks === 'failure' ? 'checks failing' : pr.checks === 'pending' ? 'checks running' : 'checks not read yet';
  const council = pr.verdict ? `council ${pr.verdict.toLowerCase()}` : 'no council verdict yet';
  return `PR #${pr.no} · ${checks} · ${council}`;
}

/**
 * The two board-wide sweeps, offered where the board is rather than only as a sentence the
 * rail understands.
 *
 * Both had a server route and a registry entry and no button: merging everything ready
 * meant clicking Merge once per lane, and clearing the finished ones off the board had no
 * route through the console at all. Neither can be undone, so each asks first.
 */
function BoardSweeps({ readyCount }: { readyCount: number }): JSX.Element {
  const mergeReady = useAction(ACTIONS.postMergeReady);
  const cleanUp = useAction(ACTIONS.postRetireFinished);
  const askingMerge = mergeReady.result?.kind === 'confirm';
  const askingClean = cleanUp.result?.kind === 'confirm';
  return (
    <div data-testid="board-sweeps" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      <button
        type="button" className={`btn ${askingMerge ? 'warn' : ''}`}
        data-testid="board-merge-ready"
        disabled={readyCount === 0 || mergeReady.pending}
        onClick={() => { void (askingMerge ? mergeReady.confirm() : mergeReady.run()); }}
      >
        {mergeReady.pending ? 'Merging…' : askingMerge ? 'Really merge them' : `Merge all ${readyCount} ready`}
      </button>
      <button
        type="button" className={`btn ${askingClean ? 'warn' : ''}`}
        data-testid="board-retire-finished"
        disabled={cleanUp.pending}
        onClick={() => { void (askingClean ? cleanUp.confirm() : cleanUp.run()); }}
      >
        {cleanUp.pending ? 'Clearing…' : askingClean ? 'Really clear them' : 'Clear the finished ones'}
      </button>
      {mergeReady.result?.kind === 'done' && !mergeReady.result.ok ? (
        <span role="alert" style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{mergeReady.result.text}</span>
      ) : null}
      {cleanUp.result?.kind === 'done' && !cleanUp.result.ok ? (
        <span role="alert" style={{ fontSize: 'var(--fs-meta)', color: 'var(--warn)' }}>{cleanUp.result.text}</span>
      ) : null}
    </div>
  );
}

/**
 * A board row's action, which says so the moment it is pressed.
 *
 * These two rows called straight through and rendered nothing, so a click sat there
 * looking unpressed until the next poll -- several seconds, on a merge (Aaron,
 * 2026-09-13). The pending state was already dispatched on every call; nothing here read
 * it.
 */
function CommandButton({ lane, cmd, label, kind, onCommand }: {
  lane: Lane; cmd: BoardCommand; label: string; kind: string;
  onCommand: (id: string, cmd: BoardCommand) => void;
}): JSX.Element {
  const busy = useCommandPending(lane.id, cmd);
  return (
    <button
      type="button" className={`btn ${kind}`} data-cmd={cmd}
      aria-busy={busy} disabled={busy}
      onClick={() => onCommand(lane.id, cmd)}
    >
      {busy ? busyLabelFor(cmd, label) : label}
    </button>
  );
}

export function LanesGrid(props: LanesGridProps): JSX.Element {
  const { lanes, blockers, queue, now, onOpen, onCommand, onLaneCommand, onQueue } = props;
  const active = lanes.filter(isActive);
  const groups = groupLanesByTicket(active);
  const idleCount = Math.max(0, queue.maxInFlight - groups.length);
  const reason = idleReason(queue);
  const ready = active.filter((lane) => boardStateWord(lane).word === 'Ready to merge');
  const blocked = active.filter((lane) => boardStateWord(lane).word === 'Blocked');
  const today = startOfToday(now);
  const finished = lanes.filter((lane) => (lane.state === 'merged' || (lane.pr?.merged === true)) && (lane.endedAt ?? lane.since) >= today);
  const handed = queue.items.filter((item) => item.handoffAt !== undefined && item.handoffAt >= today).length;

  return (
    <main data-testid="board" className="scroll" style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'auto', padding: '22px 24px 28px', display: 'flex', flexDirection: 'column', gap: 24, background: 'var(--bg)', color: 'var(--ink)', fontSize: 'var(--fs-body)', lineHeight: 1.45 }}>
      <div data-testid="lanes-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
        {groups.map((group) => (
          <LaneGroupTile key={group.key} group={group} now={now} blocker={blockerFor(group.lanes[0]!, blockers)} onOpen={onOpen} onCommand={onCommand} />
        ))}
        {Array.from({ length: idleCount }, (_, index) => (
          <div key={`idle-${index}`} data-testid="idle-slot" style={{ position: 'relative', border: `1px solid ${IDLE_STATE.border}`, borderStyle: IDLE_STATE.borderStyle, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 5, minHeight: 112 }}>
            <Marks />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <span className="key">Slot {groups.length + index + 1}</span>
              <span style={{ fontSize: 'var(--fs-kicker)', fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: IDLE_STATE.color }}>Idle</span>
            </div>
            <div className="hd" style={{ fontSize: 'var(--fs-rowhead)', lineHeight: 1.1, flex: 'none' }}>Idle</div>
            <p style={{ margin: 0, flex: 'none', color: 'var(--ink2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{reason}</p>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto' }}>
              <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>idle</span>
              <button type="button" className="btn" onClick={onQueue}>Open queue</button>
            </div>
          </div>
        ))}
      </div>

      {ready.length > 0 ? (
        <section data-testid="waiting-for-merge" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h6 className="sec">Waiting for merge <span className="n">{ready.length}</span></h6>
          {ready.map((lane) => (
            <div key={lane.id} className="rowMerge">
              <Marks />
              <span className="key">{lane.ticket ?? ''}</span>
              <span><span className="hd" style={{ fontSize: 'var(--fs-lead)' }}>{laneHeadline(lane).main}</span><span style={{ color: 'var(--ink2)' }}> — {mergeLine(lane)}</span></span>
              <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>ready {durationWords(now - lane.since)}</span>
              <CommandButton lane={lane} cmd="merge" label="Merge" kind="primary" onCommand={onCommand} />
            </div>
          ))}
        </section>
      ) : null}

      {blocked.length > 0 ? (
        <section data-testid="blocked-or-parked" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h6 className="sec">Blocked or parked <span className="n">{blocked.length}</span></h6>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {blocked.map((lane) => {
              const blocker = blockerFor(lane, blockers);
              const cta = boardCta(lane, blocker);
              const who = blocker?.who ?? (blocker && !blocker.youCanResolve ? 'Not you' : 'You');
              return (
                <div key={lane.id} className="rowBlocked">
                  <span className="key">{lane.ticket ?? ''}</span>
                  <span><span className="hd" style={{ fontSize: 'var(--fs-lead)' }}>{laneHeadline(lane).main}</span><span style={{ color: 'var(--ink2)' }}> — {blocker?.detail ?? lane.reason ?? lane.now ?? 'no reason'}</span></span>
                  <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>{who} · {durationWords(now - lane.since)}</span>
                  <CommandButton lane={lane} cmd={cta.cmd} label={cta.label} kind={cta.kind === 'secondary' ? '' : cta.kind} onCommand={onCommand} />
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <BoardSweeps readyCount={ready.length} />

      <details data-testid="finished-today" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
        <summary className="disc"><span className="tri" />Finished today <span style={{ fontWeight: 400 }}>{handed} handed to QA · {finished.length} merged</span></summary>
        <ul style={{ margin: '10px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6, color: 'var(--ink2)' }}>
          {finished.map((lane) => (
            <li key={lane.id} className="rowDone">
              <span className="hd" style={{ letterSpacing: '.05em' }}>{lane.ticket ?? ''}</span>
              <span>{laneHeadline(lane).main} — merged</span>
              <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink3)' }}>{hm(lane.endedAt ?? lane.since)}</span>
            </li>
          ))}
        </ul>
      </details>
    </main>
  );
}

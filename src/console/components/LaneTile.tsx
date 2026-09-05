import type { JSX } from 'react';
import { useState } from 'react';

import type { LaneRecord } from '../types.js';
import { Freshness } from './Freshness.js';

export interface LaneTileProps {
  lane: LaneRecord;
  now?: number;
  disabledReason?: string;
  onSend: (run: string, text: string) => Promise<void>;
  onClear: (lane: string) => Promise<void>;
}

const CONTEXT_CEILING = 200_000;

const RUN_STATE_LABEL: Record<string, string> = {
  started: 'running',
  paused: 'paused',
  parked: 'blocked',
  'handed-off': 'handing-off',
};

function stateOf(lane: LaneRecord): string {
  // X1: a live run wins over the lane's own verdict/column, which describe whichever
  // chain last finished rather than what is running right now. `finished` falls through
  // deliberately -- once a run is done, the lane's own verdict is the more informative
  // label (`done`, `failed`, and so on) than a bare "finished".
  if (lane.run_state && lane.run_state in RUN_STATE_LABEL) return RUN_STATE_LABEL[lane.run_state]!;
  if (lane.needs_aaron) return 'blocked';
  if (lane.verdict) return lane.column === 'blocked' ? 'blocked' : lane.verdict;
  if (lane.column) return lane.column;
  return 'running';
}

export function LaneTile({ lane, now, disabledReason, onSend, onClear }: LaneTileProps): JSX.Element {
  const state = stateOf(lane);
  const contextPct = Math.min(100, Math.round((lane.context / CONTEXT_CEILING) * 100));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const disabled = Boolean(disabledReason) || busy;

  const send = async (): Promise<void> => {
    if (!text.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSend(lane.slug, text);
      setText('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'that message did not go through');
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await onClear(lane.slug);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'clearing this lane did not go through');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="lane-tile" data-lane={lane.slug}>
      <div className="lane-tile__head">
        <div>
          <p className="lane-tile__slug">{lane.slug}</p>
          {lane.goal ? <p className="lane-tile__goal">{lane.goal}</p> : null}
        </div>
        <span className={`pill pill--state-${state}`}>{state}</span>
      </div>

      <div className="lane-tile__row">
        <span>{lane.className ?? 'unknown class'} · {lane.model ?? 'model unknown'}</span>
        <span>${lane.usd_per_hour.toFixed(2)}/h</span>
      </div>

      <div>
        <div className="context-bar" role="img" aria-label={`context ${contextPct}%`}>
          <div className="context-bar__fill" style={{ width: `${contextPct}%` }} />
        </div>
      </div>

      <div className="lane-tile__row">
        <span>{lane.current_tool ? `running ${lane.current_tool.name}` : `idle ${lane.last_event_age_s}s`}</span>
        <Freshness verifiedAt={lane.verified_at} now={now} />
      </div>

      <div className="inbox-card__free-text">
        <input
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Send to this run"
          aria-label={`send a message to ${lane.slug}`}
          disabled={disabled}
        />
        <button type="button" className="btn" disabled={disabled || !text.trim()} onClick={() => void send()}>
          Send
        </button>
      </div>

      {lane.needs_aaron ? (
        <button type="button" className="btn btn--primary" disabled={disabled} onClick={() => void clear()}>
          Clear
        </button>
      ) : null}

      {error ? <p className="inbox-card__error">{error}</p> : null}
    </article>
  );
}

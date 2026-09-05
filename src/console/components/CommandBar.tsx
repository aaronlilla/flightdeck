import type { JSX } from 'react';
import type { ForgeState } from '../types.js';
import { Freshness } from './Freshness.js';

export interface CommandBarProps {
  state: ForgeState | undefined;
  disabledReason: string | undefined;
  onStop: () => void;
  stopping: boolean;
  now?: number;
}

function count(lanes: ForgeState['lanes']['value'] | undefined, predicate: (column: string) => boolean): number {
  return (lanes ?? []).filter((lane) => predicate(lane.column)).length;
}

export function CommandBar({ state, disabledReason, onStop, stopping, now }: CommandBarProps): JSX.Element {
  const lanes = state?.lanes.value;
  const running = count(lanes, (column) => column !== 'blocked' && column !== 'done' && column !== 'parked');
  const blocked = count(lanes, (column) => column === 'blocked');
  const done = count(lanes, (column) => column === 'done');

  return (
    <header className="command-bar">
      <h1 className="command-bar__title">Forge fleet</h1>
      <div className="command-bar__stats">
        <span className="stat-chip stat-chip--hero">
          <span className="stat-chip__value">{running}</span>
          <span className="stat-chip__label">running</span>
        </span>
        <span className="stat-chip">
          <span className="stat-chip__value">{blocked}</span>
          <span className="stat-chip__label">blocked</span>
        </span>
        <span className="stat-chip">
          <span className="stat-chip__value">{done}</span>
          <span className="stat-chip__label">done</span>
        </span>
        {state ? (
          <span className="stat-chip">
            <span className="stat-chip__value">
              ${Object.values(state.burn.value).reduce((sum, v) => sum + v, 0).toFixed(2)}
            </span>
            <span className="stat-chip__label">burn</span>
            <Freshness verifiedAt={state.burn.verified_at} observedAt={state.burn.observed_at} now={now} />
          </span>
        ) : null}
        {/* X3: fleet capacity per tier against the five-hour window. Nothing in
            this repository computes that yet (no Governor exists), so this
            says so plainly rather than showing a number nobody backs. */}
        <span className="stat-chip stat-chip--unwired">
          <span className="stat-chip__label">capacity: not wired</span>
        </span>
      </div>
      <div className="command-bar__actions">
        <button
          type="button"
          className="btn"
          disabled
          title="forge up is the process serving this page; it is already running"
        >
          Start
        </button>
        <button
          type="button"
          className="btn btn--danger"
          onClick={onStop}
          disabled={Boolean(disabledReason) || stopping}
          title={disabledReason}
        >
          {stopping ? 'Stopping…' : 'Stop all'}
        </button>
      </div>
    </header>
  );
}

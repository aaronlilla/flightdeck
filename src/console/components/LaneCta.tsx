import type { CSSProperties, JSX } from 'react';

import { ACTIONS, type ActionSpec } from '../actions.js';
import { actionable } from '../keyboard-actionable.js';
import type { LaneCommand } from '../laneVM.js';
import type { Lane } from '../../shared/console-model.js';
import { ActionButton } from './ActionButton.js';

/**
 * One lane call to action, on a tile or in the ticket sheet. A command that changes
 * the lane (kill, merge, pause, resume, compact, verify, reopen, unretire, reconnect
 * the integration it is blocked on) is a catalog action and renders with the full
 * contract; a command that only opens something (watch, answer, council, the gate
 * log, the PR) stays a plain button the caller handles.
 */
export interface LaneCtaProps {
  lane: Lane;
  cmd: LaneCommand | 'pause';
  label: string;
  cls: string;
  style?: CSSProperties;
  onCommand: (id: string, cmd: string) => void;
  /** On a tile, a click must not also open the tile. */
  stopPropagation?: boolean;
  outcome?: 'inline' | 'none';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function specFor(cmd: string, lane: Lane): { spec: ActionSpec<any, any>; args: unknown[]; actionRef: string } | null {
  switch (cmd) {
    case 'kill': return { spec: ACTIONS.killRun, args: [lane.id, 'killed from the console'], actionRef: lane.id };
    case 'merge': return { spec: ACTIONS.mergeRun, args: [lane.id], actionRef: lane.id };
    case 'pause': return { spec: ACTIONS.pauseRun, args: [lane.id], actionRef: lane.id };
    case 'resume': return { spec: ACTIONS.resumeRun, args: [lane.id], actionRef: lane.id };
    case 'compact': return { spec: ACTIONS.compactRun, args: [lane.id], actionRef: lane.id };
    case 'verify': return { spec: ACTIONS.verifyRun, args: [lane.id], actionRef: lane.id };
    case 'reopen': return { spec: ACTIONS.reopenRun, args: [lane.id], actionRef: lane.id };
    case 'unretire': return { spec: ACTIONS.unretireRun, args: [lane.id], actionRef: lane.id };
    case 'reconnect-aws':
      return lane.blockedBy ? { spec: ACTIONS.reconnectIntegration, args: [lane.blockedBy], actionRef: `${lane.blockedBy}-${lane.id}` } : null;
    default: return null;
  }
}

export function LaneCta({ lane, cmd, label, cls, style, onCommand, stopPropagation = false, outcome = 'inline' }: LaneCtaProps): JSX.Element {
  const bound = specFor(cmd, lane);
  if (!bound) {
    return (
      <span className={cls} style={style} {...actionable((e) => { if (stopPropagation) e?.stopPropagation?.(); onCommand(lane.id, cmd); })}>
        {label}
      </span>
    );
  }
  return (
    <ActionButton
      spec={bound.spec} args={bound.args} actionRef={bound.actionRef} className={cls} style={style}
      stopPropagation={stopPropagation} outcome={outcome} testId={`lane-cta-${cmd}-${lane.id}`}
    >
      {label}
    </ActionButton>
  );
}

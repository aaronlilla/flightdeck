/**
 * The one place that turns a contract `Lane` into what a tile shows: glyph,
 * color, label, and the single CTA the HANDOFF names for that state. Kept
 * separate from the components so a test can assert "exactly one CTA per
 * state" without rendering anything.
 */
import type { Lane, LaneState } from '../shared/console-model.js';

export interface StateGlyph {
  glyph: string;
  color: string;
  label: string;
}

const STATE_GLYPH: Record<LaneState, StateGlyph> = {
  running: { glyph: '●', color: 'var(--run)', label: 'running' },
  'handed-off': { glyph: '▲', color: 'var(--hand)', label: 'handed-off' },
  paused: { glyph: '❙❙', color: 'var(--pause)', label: 'paused' },
  parked: { glyph: '◆', color: 'var(--park)', label: 'parked' },
  done: { glyph: '✓', color: 'var(--run)', label: 'done' },
  merged: { glyph: '⇗', color: 'var(--merge)', label: 'merged' },
  blocked: { glyph: '■', color: 'var(--block)', label: 'blocked' },
  exhausted: { glyph: '◍', color: 'var(--exh)', label: 'exhausted' },
  killed: { glyph: '⌀', color: 'var(--ink3)', label: 'killed' },
  unverified: { glyph: '◌', color: 'var(--ink3)', label: 'unverified' },
};

export function stateOf(state: LaneState): StateGlyph {
  return STATE_GLYPH[state];
}

export interface LaneCta {
  label: string;
  cmd: LaneCommand;
  cls: 'btnP' | 'btnA' | 'btnR' | 'btnS';
}

export type LaneCommand =
  | 'watch' | 'kill' | 'answer' | 'council' | 'resume' | 'merge'
  | 'gate-log' | 'reconnect-aws' | 'compact' | 'verify' | 'open-pr' | 'reopen';

/**
 * Exactly one CTA per lane state (HANDOFF "Board" section). `runaway` overrides
 * `running`'s CTA, and a `blocked` lane provisioning-blocked on an integration
 * offers reconnect instead of the gate log.
 */
export function laneCta(lane: Lane): LaneCta {
  if (lane.state === 'running' && lane.runaway) return { label: 'Kill attempt', cmd: 'kill', cls: 'btnR' };
  switch (lane.state) {
    case 'running':
      return { label: 'Watch live', cmd: 'watch', cls: 'btnS' };
    case 'parked':
      return { label: 'Answer →', cmd: 'answer', cls: 'btnA' };
    case 'handed-off':
      return { label: 'View council', cmd: 'council', cls: 'btnS' };
    case 'paused':
      return { label: 'Resume ▶', cmd: 'resume', cls: 'btnP' };
    case 'done':
      return { label: 'Merge now →', cmd: 'merge', cls: 'btnP' };
    case 'blocked':
      return lane.blockedBy === 'aws'
        ? { label: 'Reconnect AWS →', cmd: 'reconnect-aws', cls: 'btnA' }
        : { label: 'Gate log →', cmd: 'gate-log', cls: 'btnS' };
    case 'exhausted':
      return { label: 'Compact + resume →', cmd: 'compact', cls: 'btnP' };
    case 'unverified':
      return { label: 'Verify →', cmd: 'verify', cls: 'btnS' };
    case 'merged':
      return { label: 'Open PR ↗', cmd: 'open-pr', cls: 'btnS' };
    case 'killed':
      return { label: 'Reopen', cmd: 'reopen', cls: 'btnS' };
    default:
      return { label: 'Watch live', cmd: 'watch', cls: 'btnS' };
  }
}

export function ctxPercent(lane: Lane): number {
  if (lane.ctxCeiling <= 0) return 0;
  return Math.min(100, Math.round((lane.ctxTokens / lane.ctxCeiling) * 100));
}

export function costClass(lane: Lane): 'w0' | 'w1' | 'w2' {
  if (lane.capUsd !== null && lane.costUsd > lane.capUsd) return 'w2';
  if (lane.costUsd >= 5) return 'w1';
  return 'w0';
}

export function capText(lane: Lane): string {
  if (lane.capUsd === null) return '';
  if (lane.costUsd > lane.capUsd) {
    const times = (lane.costUsd / lane.capUsd).toFixed(1);
    return `cap $${lane.capUsd} · exceeded x${times}`;
  }
  return `cap $${lane.capUsd}`;
}

/**
 * The one place that turns a contract `Lane` into what a tile shows: glyph,
 * color, label, and the single CTA the HANDOFF names for that state. Kept
 * separate from the components so a test can assert "exactly one CTA per
 * state" without rendering anything.
 */
import { hm } from './freshness.js';
import type { Freshness } from './freshness.js';
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

export interface LaneHeadline {
  /** The big line: the ticket when the lane has one, the run id otherwise. */
  main: string;
  /** The small mono line beneath it, the run id, only when a ticket is showing. */
  sub: string | null;
}

/** The one rule for what a lane's headline says, shared by the tile, the ticket
 *  sheet band and the needs-you plates: a ticket outranks the run id, but the
 *  run id only earns its own line when it actually says something the ticket
 *  didn't -- most of today's lanes still key their ticket off their own id. */
export function laneHeadline(lane: Lane): LaneHeadline {
  if (lane.ticket && lane.ticket !== lane.id) return { main: lane.ticket, sub: lane.id };
  return { main: lane.ticket ?? lane.id, sub: null };
}

export function ctxPercent(lane: Lane): number {
  if (lane.ctxCeiling <= 0) return 0;
  return Math.min(100, Math.round((lane.ctxTokens / lane.ctxCeiling) * 100));
}

/** Prefix a tile's step text with `step N/M · ` when the lane has a step total, exactly
 *  as the prototype's `l.stepN?'step '+l.stepN+'/'+l.stepTotal+' · ':''` did. */
export function stepDisplay(lane: Lane): string {
  return lane.stepTotal > 0 ? `step ${lane.stepN}/${lane.stepTotal} · ${lane.stepText}` : lane.stepText;
}

/** `stale` renders the cost readout phosphor-off (dim, no glow) regardless of amount.
 *  The tile passes `true` for an observed value; other callers (cost sheet, ticket
 *  sheet) never pass it, so their readout still reflects the amount. */
export function costClass(lane: Lane, stale = false): 'w0' | 'w1' | 'w2' | 'ws' {
  if (stale) return 'ws';
  if (lane.capUsd !== null && lane.costUsd > lane.capUsd) return 'w2';
  if (lane.costUsd >= 5) return 'w1';
  return 'w0';
}

export function capText(lane: Lane): string {
  if (lane.capUsd === null) return '';
  if (lane.costUsd > lane.capUsd) {
    const times = (lane.costUsd / lane.capUsd).toFixed(1);
    return `cap $${lane.capUsd} · exceeded ×${times}`;
  }
  return `cap $${lane.capUsd}`;
}

/** The tile shows the cap only for a runaway lane; a lane merely under its per-run
 *  cap says nothing next to the cost (the cap sheet and hover card show it either way). */
export function tileCapText(lane: Lane): string {
  return lane.runaway ? capText(lane) : '';
}

export interface TipContent {
  head: string;
  body: string;
  click: string;
  color?: string;
}

function whenLabel(fresh: Freshness): string {
  return `${fresh.verified ? 'verified' : 'observed'} ${hm(fresh.at)}`;
}

/** Real hover cards (HANDOFF "Hover cards"): head, then a body carrying the value, its
 *  source and when it was last known, then a "Click → target" line. */
export function costTip(lane: Lane, fresh: Freshness): TipContent {
  const over = lane.capUsd !== null && lane.costUsd > lane.capUsd;
  return {
    head: `$${lane.costUsd.toFixed(2)}${over ? ' · over cap' : ''}`,
    body: `value $${lane.costUsd.toFixed(2)} · source ${lane.sandbox?.id ?? lane.id} · ${whenLabel(fresh)}`,
    click: 'Click → cost sheet',
    color: over ? '#ff5c47' : '#9df598',
  };
}

export function ctxTip(lane: Lane, fresh: Freshness): TipContent {
  const pct = ctxPercent(lane);
  return {
    head: `${pct}% context`,
    body: `value ${Math.round(lane.ctxTokens / 1000)}k / ${Math.round(lane.ctxCeiling / 1000)}k tokens · source ${lane.id} · ${whenLabel(fresh)}`,
    click: 'Click → ticket sheet',
  };
}

export function modelTip(lane: Lane, fresh: Freshness): TipContent {
  return {
    head: lane.model,
    body: `value ${lane.modelId ?? lane.model} · source ${lane.id} · ${whenLabel(fresh)}`,
    click: 'Click → ticket sheet',
  };
}

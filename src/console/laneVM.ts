/**
 * The one place that turns a contract `Lane` into what a tile shows: glyph,
 * color, label, and the single CTA the HANDOFF names for that state. Kept
 * separate from the components so a test can assert "exactly one CTA per
 * state" without rendering anything.
 */
import { hm } from './freshness.js';
import type { Freshness } from './freshness.js';
import type { Lane, LaneState } from '../shared/console-model.js';
import { fmtTokens } from '../shared/format-tokens.js';

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
  /** The line every headline renders: the ticket if the lane has one, else the run id. */
  main: string;
  /** The lane's run id. Goes in the `title` attribute, never on its own visible
   *  line, since the prototype's tile headline is one line: `{{l.id}}`. */
  runId: string;
}

/** What a lane's headline says, shared by the tile, the ticket sheet band, and
 *  the needs-you plates: a ticket outranks the run id, and the run id only
 *  shows up in `title`, matching the prototype's single-line `l.id`. */
export function laneHeadline(lane: Lane): LaneHeadline {
  return { main: lane.ticket ?? lane.id, runId: lane.id };
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

/** The amber line for a lane carrying no cap of its own: a token count past this reads
 *  as "getting expensive" the same way the old `$5` threshold did. Chosen rather than
 *  derived, because there is no single honest exchange rate any more (see
 *  `console-model.ts`'s own note on why token caps carry no dollar default) -- but the
 *  old `$5` threshold, at Sonnet's blended list rate (input $3/M, output $15/M), sat
 *  somewhere between roughly 300k and 1.6M tokens depending on the input/output mix.
 *  1,000,000 is a round number inside that band. */
const EXPENSIVE_TOKENS = 1_000_000;

/** `stale` renders the cost readout phosphor-off (dim, no glow) regardless of amount.
 *  The tile passes `true` for an observed value; other callers (cost sheet, ticket
 *  sheet) never pass it, so their readout still reflects the amount. */
export function costClass(lane: Lane, stale = false): 'w0' | 'w1' | 'w2' | 'ws' {
  if (stale) return 'ws';
  if (lane.tokenCap !== null && lane.tokens > lane.tokenCap) return 'w2';
  if (lane.tokens >= EXPENSIVE_TOKENS) return 'w1';
  return 'w0';
}

/** Matches the prototype's own `'cap $'+l.cap+' · ×'+Math.round(l.cost/l.cap)` in shape:
 *  no word "exceeded", and the multiplier is rounded rather than shown to one decimal --
 *  rendered in tokens, compact, since this fleet has nothing left to price in dollars. */
export function capText(lane: Lane): string {
  if (lane.tokenCap === null) return '';
  if (lane.tokens > lane.tokenCap) {
    const times = Math.round(lane.tokens / lane.tokenCap);
    return `cap ${fmtTokens(lane.tokenCap)} tokens · ×${times}`;
  }
  return `cap ${fmtTokens(lane.tokenCap)} tokens`;
}

/** The tile shows the cap text whenever cost exceeds cap, not only for a lane also
 *  flagged `runaway`: a lane can quietly cross its cap without ever being marked
 *  runaway, and it still needs the warning. */
export function tileCapText(lane: Lane): string {
  return lane.tokenCap !== null && lane.tokens > lane.tokenCap ? capText(lane) : '';
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
  const over = lane.tokenCap !== null && lane.tokens > lane.tokenCap;
  return {
    head: `${fmtTokens(lane.tokens)} tokens${over ? ' · over cap' : ''}`,
    body: `value ${fmtTokens(lane.tokens)} tokens · source ${lane.sandbox?.id ?? lane.id} · ${whenLabel(fresh)}`,
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

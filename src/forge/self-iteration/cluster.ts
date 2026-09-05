/**
 * Roadmap P4.6, F30's first remaining part (dispatcher decision 5,
 * `2026-09-04-forge-self-iteration.md`): group gotchas by root cause, not by the exact
 * text `gotcha.ts`'s `Gotchas.file` already dedupes on. Two workers can hit the same
 * underlying break with a different pid in the stack trace and a different absolute path
 * in the error, and today those file as two unrelated gotchas that never get folded into
 * one proposal.
 *
 * Structural on purpose (decision 5): no model call sits behind this by default, so
 * clustering a thousand gotchas costs nothing and never drifts between two runs of the
 * same input. `reasonerFor` is the seam a caller can hand a `Reasoner` through later, off
 * by default, for the harder case this module does not try to solve -- two gotchas whose
 * text has nothing in common but whose root cause is the same bug.
 */
import { createHash } from 'node:crypto';

import type { Gotcha } from '../gotcha.js';
import type { Reasoner } from '../contracts.js';

export interface Cluster {
  id: string;
  key: string;
  toolName: string;
  normalizedError: string;
  frames: string[];
  gotchaIds: string[];
  causeSummary: string;
}

/** The command or the leading path segment of `where`, whichever reads as the tool. */
export function toolNameFor(where: string): string {
  const trimmed = (where ?? '').trim();
  const firstWord = trimmed.split(/\s+/, 1)[0] ?? '';
  const base = firstWord.split(/[\\/]/).pop() ?? firstWord;
  return base.replace(/\.[a-z0-9]+$/i, '').toLowerCase() || 'unknown';
}

/** Numbers, ids and paths masked out, so two errors differing only in those still match. */
export function normalizeErrorText(error: string): string {
  return (error ?? '')
    .replace(/[A-Za-z]:[\\/][^\s"'`]+/g, '<path>')
    .replace(/\/[^\s"'`]*\/[^\s"'`]*/g, '<path>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<id>')
    .replace(/\b\d+\b/g, '#')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** The top two frame-shaped lines of a multi-line error, normalized the same way. */
export function topFrames(error: string, max = 2): string[] {
  const frameLike = /\bat\s+\S+|\bFile\s+"[^"]+",\s+line\s+\d+/;
  return (error ?? '')
    .split(/\r?\n/)
    .filter((line) => frameLike.test(line))
    .slice(0, max)
    .map((line) => normalizeErrorText(line));
}

function clusterKey(toolName: string, normalizedError: string, frames: string[]): string {
  return createHash('sha256').update(`${toolName}|${normalizedError}|${frames.join('|')}`).digest('hex').slice(0, 16);
}

export interface ClusterDeps {
  /** Off by default (decision 5): a structural miss is left as its own singleton cluster
   *  rather than forced into one by a model call nobody asked for. */
  reasoner?: Reasoner;
}

/**
 * Folds a flat list of gotchas into clusters sharing a tool name, a normalized error, and
 * the same leading stack frames when the error carries any. A gotcha whose structural key
 * matches no other stands alone as a cluster of one -- that is not a failure of this
 * function, it is an honest report that nothing else looked the same.
 */
export function clusterGotchas(gotchas: Gotcha[], _deps: ClusterDeps = {}): Cluster[] {
  const byKey = new Map<string, Cluster>();

  for (const gotcha of gotchas) {
    const toolName = toolNameFor(gotcha.where);
    const normalizedError = normalizeErrorText(gotcha.error);
    const frames = topFrames(gotcha.error);
    const key = clusterKey(toolName, normalizedError, frames);

    const existing = byKey.get(key);
    if (existing) {
      existing.gotchaIds.push(gotcha.id);
      continue;
    }
    byKey.set(key, {
      id: key,
      key,
      toolName,
      normalizedError,
      frames,
      gotchaIds: [gotcha.id],
      causeSummary: `${toolName}: ${normalizedError}`.slice(0, 240),
    });
  }

  return [...byKey.values()];
}

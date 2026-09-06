/**
 * `GET /proposals`: the daily flight review -- today's merge/wait/cost metrics folded
 * from the journal, plus the rules the operator can apply, dismiss or restore (S3 writes
 * `~/.forge/console/rules.json`; this only reads it and adds the rules this server can
 * generate on its own from what it already sees).
 */
import { existsSync, readFileSync } from 'node:fs';

import type { ForgeEvent } from '../journal.js';
import type { ProposalsResponse, ReviewMetrics, Rule } from '../../shared/console-model.js';

export function rulesPath(forgeHomeDir: string): string {
  return `${forgeHomeDir}/console/rules.json`;
}

export function readRules(path: string): Rule[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { rules?: Rule[] };
    return parsed.rules ?? [];
  } catch {
    return [];
  }
}

function startOfLocalDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Today's metrics, computed straight off the journal: `mergedToday` counts
 * `chain.merged` rows, `humanWaitMin` sums every `run.parked` -> `ask.answered` gap for a
 * key answered today, `tokensPerMerge` divides today's spend by `mergedToday` (`null`
 * with nothing merged yet, never a division by zero wearing a number), and `tokensWasted`
 * adds up the spend of every run whose last state today is `killed`, `exhausted` or
 * `blocked` (a run that finished `done` or is still going is never wasted spend).
 */
export function computeMetrics(events: ForgeEvent[], now: number, tokensByRun: Record<string, number>): ReviewMetrics {
  const since = startOfLocalDay(now);
  const today = events.filter((row) => row.at >= since);

  const mergedToday = today.filter((row) => row.event === 'chain.merged').length;

  const parkedAt = new Map<string, number>();
  let humanWaitMs = 0;
  for (const row of today) {
    if (row.event === 'run.parked' || row.event === 'warden.parked' || row.event === 'governor.parked') {
      if (typeof row.key === 'string') parkedAt.set(row.key, row.at);
    }
    if (row.event === 'ask.answered' && typeof row.key === 'string') {
      const started = parkedAt.get(row.key);
      if (started !== undefined) {
        humanWaitMs += row.at - started;
        parkedAt.delete(row.key);
      }
    }
  }

  // `tokensByRun` carries each run's total tokens for the whole journal, not just today,
  // so "today's tokens" sums it only over runs that produced at least one event today --
  // an approximation (a run started yesterday and still burning today counts its whole
  // total), named here rather than left silent, since nothing in `RunState` tracks
  // tokens by day.
  const runsActiveToday = new Set(today.filter((row) => row.run).map((row) => row.run as string));
  const tokensToday = [...runsActiveToday].reduce((sum, run) => sum + (tokensByRun[run] ?? 0), 0);

  const lastStateByRun = new Map<string, string>();
  for (const row of today) {
    if (!row.run) continue;
    if (row.event === 'run.killed') lastStateByRun.set(row.run, 'killed');
    else if (row.event === 'run.finished' && row.verdict) lastStateByRun.set(row.run, String(row.verdict));
    else if (row.event === 'run.blocked') lastStateByRun.set(row.run, 'blocked');
  }
  let tokensWasted = 0;
  for (const [run, state] of lastStateByRun) {
    if (state === 'killed' || state === 'exhausted' || state === 'blocked') {
      tokensWasted += tokensByRun[run] ?? 0;
    }
  }

  return {
    mergedToday,
    humanWaitMin: Math.round(humanWaitMs / 60_000),
    tokensPerMerge: mergedToday > 0 ? Math.round(tokensToday / mergedToday) : null,
    tokensWasted: Math.round(tokensWasted),
  };
}

/** The two rule kinds this server can propose on its own, from evidence in today's
 *  journal, without anything under `rules.json` naming them: a run with 3+ fails today,
 *  or a question asked twice today with the same text. Skipped when a rule for the same
 *  evidence is already open, applied or dismissed in `existingRules`. */
export function generatedProposals(events: ForgeEvent[], now: number, existingRules: Rule[]): Rule[] {
  const since = startOfLocalDay(now);
  const today = events.filter((row) => row.at >= since);
  const known = new Set(existingRules.map((rule) => rule.id));
  const proposals: Rule[] = [];

  const failsByRun = new Map<string, number>();
  for (const row of today) {
    if ((row.event === 'run.blocked' || row.event === 'engine.error') && row.run) {
      failsByRun.set(row.run, (failsByRun.get(row.run) ?? 0) + 1);
    }
  }
  for (const [run, fails] of failsByRun) {
    if (fails < 3) continue;
    const id = `kill-after-fails-${run}`;
    if (known.has(id)) continue;
    proposals.push({
      id, kind: 'kill-after-fails', title: `Kill ${run} after repeated fails`,
      summary: `${run} has failed ${fails} times today.`,
      evidence: `${fails} run.blocked/engine.error rows for ${run} since local midnight`,
      effect: `kill ${run} the next time it fails again`,
      status: 'open', jid: null, prUrl: null,
    });
  }

  const askedTexts = new Map<string, number>();
  for (const row of today) {
    if (row.event !== 'ask.raised') continue;
    const question = typeof row.question === 'string' ? row.question : undefined;
    if (!question) continue;
    askedTexts.set(question, (askedTexts.get(question) ?? 0) + 1);
  }
  for (const [question, count] of askedTexts) {
    if (count < 2) continue;
    const id = `auto-answer-${Buffer.from(question).toString('base64').slice(0, 16)}`;
    if (known.has(id)) continue;
    proposals.push({
      id, kind: 'auto-answer', title: 'Auto-answer a repeated question',
      summary: `"${question}" was asked ${count} times today.`,
      evidence: `${count} ask.raised rows with this text since local midnight`,
      effect: 'answer this question automatically the next time it is asked',
      status: 'open', jid: null, prUrl: null,
    });
  }

  for (const row of today) {
    if (row.event !== 'proposal.opened') continue;
    const id = `self-iteration-${row.id}`;
    if (known.has(id)) continue;
    proposals.push({
      id, kind: 'self-iteration', title: 'Self-iteration draft PR',
      summary: 'A draft PR was opened from a clustered gotcha.',
      evidence: `proposal.opened row ${row.id}`,
      effect: 'review and merge the draft PR by hand',
      status: 'open', jid: null, prUrl: typeof row.prUrl === 'string' ? row.prUrl : null,
    });
  }

  return proposals;
}

export function computeProposals(
  events: ForgeEvent[], now: number, tokensByRun: Record<string, number>, existingRules: Rule[],
): ProposalsResponse {
  return {
    rules: [...existingRules, ...generatedProposals(events, now, existingRules)],
    metrics: computeMetrics(events, now, tokensByRun),
    computedAt: now,
  };
}

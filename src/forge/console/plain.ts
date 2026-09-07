/**
 * `plain` (H1.2): one sentence a person can act on for every lane state -- the field
 * the board's own screenshot specimen (2026-09-07) had nothing for, so a tile read as a
 * run id, a queue key and a bare verdict word with no way to tell what to do next.
 *
 * Never a run id, a hop number or a bare verdict word on its own: every branch below
 * either names a person-facing fact (a PR number, a model's own name, a turn count, a
 * clock time) or a full clause a person can act on.
 */
import type { Lane } from '../../shared/console-model.js';

export interface PlainContext {
  now: number;
}

const MODEL_NAMES: Record<string, string> = {
  'sonnet-5': 'Sonnet', 'opus-5': 'Opus', 'haiku-4.5': 'Haiku',
};

function modelName(model: string): string {
  return MODEL_NAMES[model] ?? model;
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dayLabel(at: number, now: number): string {
  const days = Math.floor((now - at) / (24 * 60 * 60_000));
  if (days <= 0) return 'today';
  const date = new Date(at);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function reviewSentence(lane: Lane): string | null {
  const pr = lane.pr;
  if (!pr) return null;
  if (pr.merged) return null;
  const checks = pr.checks === 'success' ? 'checks green'
    : pr.checks === 'failure' ? 'checks red'
      : 'checks pending';
  const verdict = pr.verdict ? `the council's ${pr.verdict}` : 'no council verdict yet';
  return `Draft PR #${pr.no} is open with ${checks} and ${verdict}; waiting for your Merge.`;
}

/** `plainStatus`: the one sentence `GET /lanes` carries for every lane, whatever its
 *  state -- computed here rather than left to a UI that would otherwise have to decode
 *  a state enum and a hop number itself. */
export function plainStatus(lane: Lane, context: PlainContext): string {
  switch (lane.state) {
    case 'running':
    case 'handed-off': {
      const model = modelName(lane.model);
      const last = lane.stepText ? `, last did: ${lane.stepText}` : '';
      return `Working since ${clockTime(lane.since)} on a ${model} session, ${lane.stepN} turns in${last}.`;
    }
    case 'paused':
      return `Paused at ${clockTime(lane.since)}. Resume to continue.`;
    case 'parked': {
      if (lane.question) {
        return `Waiting for your answer: ${truncate(lane.question.text, 90)}`;
      }
      if (lane.reason && /warden|script budget|stuck-session/i.test(lane.reason)) {
        return `Parked by the warden at ${clockTime(lane.since)}: ${lane.reason}. Resume to continue.`;
      }
      if (lane.reason) {
        return `Parked at ${clockTime(lane.since)}: ${lane.reason}. Resume to continue.`;
      }
      return `Parked at ${clockTime(lane.since)}, waiting on you. Resume to continue.`;
    }
    case 'done':
    case 'exhausted': {
      const review = reviewSentence(lane);
      if (review) return review;
      if (lane.kind === 'probe') return `Probe passed at ${clockTime(lane.since)}.`;
      if (lane.pr) {
        return `The session ended without finishing its checklist, but its PR #${lane.pr.no} is open; `
          + 'the council reviews it next.';
      }
      return `Finished at ${clockTime(lane.since)} with no pull request open.`;
    }
    case 'unverified': {
      if (lane.pr) {
        return `The session ended without finishing its checklist, but its PR #${lane.pr.no} is open; `
          + 'the council reviews it next.';
      }
      return `The session ended without finishing its checklist, and it opened no pull request.`;
    }
    case 'merged': {
      const time = `Merged into develop at ${clockTime(lane.since)}`;
      return `${time}; dev OTA not yet checked.`;
    }
    case 'blocked': {
      const day = dayLabel(lane.since, context.now);
      const reason = lane.reason ?? 'the reason has not been recorded';
      const prefix = lane.kind === 'chain' ? 'Blocked since' : 'Stuck since';
      return `${prefix} ${day}: ${reason}.`;
    }
    case 'killed': {
      const reason = lane.reason ? ` (${lane.reason})` : '';
      return `Stopped by you at ${clockTime(lane.since)}${reason}.`;
    }
    default:
      return `${lane.state}.`;
  }
}

/**
 * Activation, gated exactly like Warden's kill: "the only mechanism the sources
 * establish for 'a person decided this'" (dispatcher decision, brief's Requirements
 * section) is a `decision.made` row naming the target and the action, so activation
 * reuses that mechanism rather than inventing a second one. `warden.ts`'s `findDecision`
 * and `WardenActuator.kill` are the exact pattern mirrored here: read the whole journal
 * through `replayEvents`, refuse silently (journaling the refusal) when no row names this
 * target and `activate`, and never accept a decision id this code invented for itself.
 */
import { readFileSync } from 'node:fs';

import { replayEvents, type DecisionId } from '../contracts.js';
import { Journal } from '../journal.js';

export interface FoundDecision {
  id: string;
  target: string;
  action: string;
  reason?: string;
}

export function findActivationDecision(journalPath: string, target: string, decisionId: DecisionId): FoundDecision | undefined {
  let text: string;
  try {
    text = readFileSync(journalPath, 'utf8');
  } catch {
    return undefined;
  }
  const { events } = replayEvents(text);
  const found = events.find((event) => (
    event.id === decisionId
    && event.event === 'decision.made'
    && event.run === target
    && event['action'] === 'activate'
  ));
  if (!found) return undefined;
  return { id: found.id, target: found.run ?? target, action: 'activate', reason: found['reason'] as string | undefined };
}

export interface ActivationDeps {
  journal: Journal;
  journalPath: string;
}

export type ActivationResult =
  | { activated: true; decisionId: DecisionId }
  | { activated: false; reason: string };

/**
 * Refuses -- journaling `permission.denied`, never a self-iteration-specific event, since
 * this is exactly the same shape of refusal Warden already gives a name to -- unless a
 * `decision.made` row names this exact target and `activate`. There is no path through
 * this function that activates anything on an empty, fabricated, or wrong-target decision
 * id; that is the property the acceptance specimen for this requirement checks.
 */
export function activate(deps: ActivationDeps, target: string, decisionId: DecisionId): ActivationResult {
  const decision = findActivationDecision(deps.journalPath, target, decisionId);
  if (!decision) {
    deps.journal.append({
      event: 'permission.denied', run: target, actor: 'self-iteration',
      reason: 'no decision.made row names this target and activate',
    });
    return { activated: false, reason: 'no decision.made row names this target and activate' };
  }

  deps.journal.append({
    event: 'self-iteration.activated', run: target, actor: 'self-iteration', decisionId, evidence: [decision.id],
  });
  return { activated: true, decisionId };
}

import type { BlockerKind, MessageType } from './console-model.js';

/**
 * Nothing is offered as something to do without first saying whether it still can be.
 *
 * Aaron, 2026-09-12: "The entire board and app in general is constantly dead or old
 * information. Like all of it, it's a constant plague. Fix it permanently so it can't
 * happen."
 *
 * He is describing one defect, not many. Every surface here renders records replayed from
 * a permanent journal, and until today nothing asked whether the thing a record points at
 * still exists. Measured on the live console in one afternoon:
 *
 *     67 confirm cards   every token expired or gone with a restart
 *     90 of 92 questions pointing at a queue item that had been pruned
 *      2 board tiles     named `Untitled run` because the row holding the name was pruned
 *      1 queue item      blocking the console's own upgrade for 44 hours with no process
 *
 * Each was fixed on its own, and that is the plague rather than the cure: the next card
 * kind somebody adds is free to skip the check again, and nobody finds out until it is on
 * screen in front of a person.
 *
 * So the rule moves into the type. `Actionable` cannot be constructed without a
 * `Liveness`, the render path takes `Actionable` rather than a bare record, and
 * `LIVENESS_RULES` below must name a rule for every kind that can carry an action.
 * `tests/shared/liveness-coverage.test.ts` computes that list from the unions themselves,
 * so a new kind fails a test the day it is added rather than the week somebody notices.
 *
 * Coverage is COMPUTED, never hand-authored: the test derives the kinds from the source
 * of the unions, so this file cannot silently fall behind them.
 */

/**
 * Whether the thing a record points at still exists.
 *
 * `why` is required on the dead branch and is shown to a person, so a card can never go
 * quiet without saying what happened to it.
 */
export type Liveness =
  | { readonly live: true }
  | { readonly live: false; readonly why: string };

export const LIVE: Liveness = { live: true };

export function dead(why: string): Liveness {
  return { live: false, why };
}

/**
 * A record paired with the verdict on whether it can still be acted on.
 *
 * The pairing is the point. A component that draws a button takes this, never the bare
 * record, so there is no way to render an action without having answered the question
 * first. Answering it wrong is still possible; forgetting to ask is not.
 */
export interface Actionable<T> {
  readonly item: T;
  readonly liveness: Liveness;
}

export function actionable<T>(item: T, liveness: Liveness): Actionable<T> {
  return { item, liveness };
}

/** The ones a person can act on, out of everything the rail and the board carry. */
export type ActionableMessageType = Extract<MessageType, 'question' | 'confirm' | 'plan' | 'blocker'>;

/**
 * Every kind that can reach a person with an action on it, and what decides whether that
 * action can still land.
 *
 * A kind is here because it carries a button, not because it is important. `event`,
 * `activity`, `reply`, `receipt`, `refusal`, `thinking`, `pr`, `operator` and `decision`
 * are things that happened: they are read, never answered, and a stale one is history
 * rather than a broken promise.
 */
export interface LivenessRule {
  /** What decides whether this kind's action can still land, in words a reader can check
   *  against the code. */
  readonly decides: string;
  /**
   * Where the verdict is actually attached to the record, or `null` when nothing routes
   * this kind through `Actionable` yet.
   *
   * Stated rather than implied. The coverage test proves a rule EXISTS for every kind; it
   * cannot prove the render path uses it, so an unrouted kind says so here instead of
   * looking covered. A `null` is a known gap on the page, not a silence.
   */
  readonly seam: string | null;
}

export const LIVENESS_RULES = {
  'message:confirm': {
    decides: 'the pending token the Confirm button names still resolves',
    seam: 'forge/console/thread.ts#settleDeadConfirms, then NeedsYou#buildNeeds',
  },
  'message:question': {
    decides: 'at least one run the ask names still exists',
    seam: 'forge/console/askContext.ts, then NeedsYou#buildNeeds',
  },
  'message:plan': {
    decides: 'the pending token the Run button names still resolves',
    seam: null,
  },
  'message:blocker': {
    decides: 'the lane the card points at is still one the fleet knows',
    seam: 'NeedsYou#buildNeeds, against the Blockers slice',
  },
  'blocker:question': {
    decides: 'at least one run the ask names still exists',
    seam: 'forge/console/blockers-gather.ts, via askContextForRuns',
  },
  'blocker:integration': { decides: 'the integration is still configured', seam: null },
  'blocker:checks': { decides: 'the pull request the checks belong to is still open', seam: null },
  'blocker:billing': { decides: 'the failing run is still the head of its branch', seam: null },
  'blocker:owner': { decides: 'the pull request is still open and still needs its owner', seam: null },
  'blocker:process': { decides: 'the lane still has a registry row', seam: null },
  'lane:action': {
    decides: 'the lane is not retired and its action still applies to its state',
    seam: 'console/actionLiveness.ts#laneActionLiveness, then LaneTile',
  },
  'queue:action': {
    decides: 'the row is in the state its own button acts on',
    seam: 'console/actionLiveness.ts#queueActionLiveness, then QueueView',
  },
} as const satisfies Record<string, LivenessRule>;

export type LivenessRuleKey = keyof typeof LIVENESS_RULES;

/** The key for one message kind, so a caller cannot misspell it. */
export function messageRuleKey(type: ActionableMessageType): LivenessRuleKey {
  return `message:${type}` as LivenessRuleKey;
}

/** The key for one blocker kind. */
export function blockerRuleKey(kind: BlockerKind): LivenessRuleKey {
  return `blocker:${kind}` as LivenessRuleKey;
}

/** Whether this kind has a rule on record. The coverage test is what makes this true for
 *  every kind; this is here for a caller that wants to check one. */
export function hasLivenessRule(key: string): key is LivenessRuleKey {
  return Object.prototype.hasOwnProperty.call(LIVENESS_RULES, key);
}

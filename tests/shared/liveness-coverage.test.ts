import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LIVENESS_RULES, actionable, dead, hasLivenessRule, LIVE } from '../../src/shared/liveness.js';

/**
 * Coverage is computed from the source of the unions, never from a list kept by hand.
 *
 * Aaron, 2026-09-12: "The entire board and app in general is constantly dead or old
 * information ... Fix it permanently so it can't happen." A hand-written list of kinds
 * would go stale the same way the board did, and for the same reason: nothing would make
 * anybody update it. So this test reads `MessageType` and `BlockerKind` out of
 * `console-model.ts` and fails when a kind that can carry an action has no rule on
 * record.
 *
 * Adding a card kind with a button therefore fails a test on the day it is added, rather
 * than the week somebody notices it on screen.
 */

const MODEL = readFileSync(join(process.cwd(), 'src/shared/console-model.ts'), 'utf8');

function unionMembers(declaration: string): string[] {
  const start = MODEL.indexOf(declaration);
  if (start === -1) throw new Error(`Could not find "${declaration}" in console-model.ts`);
  const body = MODEL.slice(start + declaration.length, MODEL.indexOf(';', start));
  return [...body.matchAll(/'([a-z-]+)'/g)].map((match) => match[1] as string);
}

/**
 * The message kinds that carry a button, named here because "does this kind have an
 * action" is a fact about the components rather than about the type. Every OTHER member
 * of the union is asserted to be deliberately excluded below, so the pair of lists is
 * still checked against the real union and neither can drift on its own.
 */
const ACTIONABLE_MESSAGES = ['question', 'confirm', 'plan', 'blocker'];

/** Kinds a person reads and never answers: a stale one is history, not a dead promise. */
const READ_ONLY_MESSAGES = [
  'event', 'activity', 'operator', 'reply', 'receipt', 'refusal', 'pr', 'thinking', 'decision',
];

describe('every kind that can carry an action has a liveness rule', () => {
  it('accounts for every member of MessageType, with none left unclassified', () => {
    const declared = unionMembers('export type MessageType =');
    expect(declared.length).toBeGreaterThan(0);
    const classified = [...ACTIONABLE_MESSAGES, ...READ_ONLY_MESSAGES].sort();
    expect(declared.slice().sort()).toEqual(classified);
  });

  it('has a rule for every actionable message kind', () => {
    const missing = ACTIONABLE_MESSAGES.filter((kind) => !hasLivenessRule(`message:${kind}`));
    expect(missing).toEqual([]);
  });

  it('has a rule for every blocker kind the model declares', () => {
    const declared = unionMembers('export type BlockerKind =');
    expect(declared.length).toBeGreaterThan(0);
    const missing = declared.filter((kind) => !hasLivenessRule(`blocker:${kind}`));
    expect(missing).toEqual([]);
  });

  it('has a rule for the lane and queue actions', () => {
    expect(hasLivenessRule('lane:action')).toBe(true);
    expect(hasLivenessRule('queue:action')).toBe(true);
  });

  it('carries no rule for a kind that does not exist, so the list cannot rot quietly', () => {
    const declaredMessages = unionMembers('export type MessageType =');
    const declaredBlockers = unionMembers('export type BlockerKind =');
    const stale = Object.keys(LIVENESS_RULES).filter((key) => {
      const [space, kind] = key.split(':') as [string, string];
      if (space === 'message') return !declaredMessages.includes(kind);
      if (space === 'blocker') return !declaredBlockers.includes(kind);
      return false;
    });
    expect(stale).toEqual([]);
  });

  it('says in words what each rule decides, so a reader can check it against the code', () => {
    for (const [key, rule] of Object.entries(LIVENESS_RULES)) {
      expect(rule.decides.length, `${key} has no stated rule`).toBeGreaterThan(20);
    }
  });

  /**
   * The gap this test exists to keep visible: a rule being on record does not mean the
   * render path uses it. A kind with `seam: null` is declared and NOT enforced, and it
   * says so in the source rather than looking covered. This asserts the wired set only
   * grows -- a seam that goes back to null fails here.
   */
  it('names the seam for every kind already routed through the verdict', () => {
    const WIRED = [
      'message:confirm', 'message:question', 'message:blocker', 'blocker:question',
      'lane:action', 'queue:action',
    ];
    const unwired = WIRED.filter((key) => LIVENESS_RULES[key as keyof typeof LIVENESS_RULES].seam === null);
    expect(unwired, 'a kind that was enforced has stopped being enforced').toEqual([]);
  });

  it('is honest about the kinds not routed through the verdict yet', () => {
    const pending = Object.entries(LIVENESS_RULES)
      .filter(([, rule]) => rule.seam === null)
      .map(([key]) => key);
    // Not an empty list, and not asserted to be one. These are known gaps, on the page.
    expect(pending).toEqual([
      'message:plan',
      'blocker:integration', 'blocker:checks', 'blocker:billing', 'blocker:owner', 'blocker:process',
    ]);
  });
});

describe('the verdict a record is paired with', () => {
  it('cannot be built without one', () => {
    const wrapped = actionable({ k: 'c1' }, LIVE);
    expect(wrapped.liveness).toEqual({ live: true });
  });

  it('carries a reason on the dead branch, so nothing goes quiet without saying why', () => {
    const wrapped = actionable({ k: 'c1' }, dead('its queue item has been removed'));
    expect(wrapped.liveness.live).toBe(false);
    expect(wrapped.liveness.live === false && wrapped.liveness.why).toBe('its queue item has been removed');
  });
});

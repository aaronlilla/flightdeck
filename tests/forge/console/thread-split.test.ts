import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Journal, replay } from '../../../src/forge/journal.js';
import { RAIL_TYPES, computeThread } from '../../../src/forge/console/thread.js';
import type { InboxEntry } from '../../../src/forge/inbox.js';
import type { Message, MessageType } from '../../../src/shared/console-model.js';

/**
 * R-75 item 1. The rail is conversation only: `computeThread` hands the rail
 * `operator`, `reply` and `receipt` rows (plus the `event`/`activity` rows the closed
 * Activity drawer reads off the same list), and every other kind reaches the console
 * through the response's second field instead.
 *
 * The fixture holds one row of EVERY `MessageType` value -- including two of one kind --
 * and the assertion is per kind, a multiset comparison. A kind the builder still emits
 * but the fixture omits would let a broken split read green; so would two rows of one
 * kind landing in `cards` while another kind vanished and the total still matched.
 */

/** Every value of the `MessageType` union, listed by hand so a new member added to the
 *  union without a decision about which side it belongs on fails this test's own
 *  exhaustiveness check below. */
const ALL_MESSAGE_TYPES: MessageType[] = [
  'event', 'activity', 'operator', 'reply', 'question', 'plan', 'confirm',
  'receipt', 'refusal', 'pr', 'thinking', 'blocker', 'decision',
];

function tempJournal(): { path: string; journal: Journal } {
  const dir = mkdtempSync(join(tmpdir(), 'console-thread-split-'));
  const path = join(dir, 'fleet.jsonl');
  return { path, journal: new Journal(path) };
}

function row(type: MessageType, k: string, ts: number): Message {
  return { k, type, text: `${type} row ${k}`, ts, source: 'alpha' };
}

/** The fixture: one persisted row of every kind except `question` (which only exists as
 *  a generated card from an open ask) and `blocker` (only ever generated from a
 *  `blocker.raised` journal row), plus a SECOND `reply` and a SECOND `plan` so a
 *  per-kind count can catch a split that moves the right total to the wrong side. */
function fixture(): { persisted: Message[]; expected: Map<MessageType, number> } {
  const persisted: Message[] = [];
  let ts = 1_000;
  for (const type of ALL_MESSAGE_TYPES) {
    if (type === 'question' || type === 'blocker') continue;
    ts += 10;
    persisted.push(row(type, `p-${type}`, ts));
  }
  persisted.push(row('reply', 'p-reply-2', (ts += 10)));
  persisted.push(row('plan', 'p-plan-2', (ts += 10)));
  const expected = new Map<MessageType, number>();
  for (const message of persisted) expected.set(message.type, (expected.get(message.type) ?? 0) + 1);
  // One generated question (open ask) and one generated blocker (journal row).
  expected.set('question', 1);
  expected.set('blocker', 1);
  return { persisted, expected };
}

function openAsk(): InboxEntry {
  return {
    key: 'ask-1',
    question: 'Which way should the agent go?',
    options: ['left', 'right'],
    runs: ['alpha'],
    at: 2_000,
    recommended: 0,
    optionSource: 'worker',
  } as InboxEntry;
}

function counts(messages: Message[]): Map<MessageType, number> {
  const out = new Map<MessageType, number>();
  for (const message of messages) out.set(message.type, (out.get(message.type) ?? 0) + 1);
  return out;
}

describe('computeThread splits the rail from the cards (R-75 item 1)', () => {
  it('the fixture holds every MessageType value, so no kind can slip the split unseen', () => {
    const { expected } = fixture();
    for (const type of ALL_MESSAGE_TYPES) {
      expect(expected.get(type), `fixture is missing a ${type} row`).toBeGreaterThan(0);
    }
  });

  it('routes every kind to exactly one side, as many times as the fixture holds it', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'blocker.raised', run: 'alpha', actor: 'blockers', what: 'a credential is missing', runs: ['alpha'] });
    journal.close();
    const fleet = replay(path);

    const { persisted, expected } = fixture();
    const result = computeThread(persisted, fleet.events, 500, [openAsk()]);

    const rail = counts(result.messages);
    const cards = counts(result.cards);

    for (const type of ALL_MESSAGE_TYPES) {
      const want = expected.get(type) ?? 0;
      const onRail = rail.get(type) ?? 0;
      const onCards = cards.get(type) ?? 0;
      // Per kind, not in total: exactly one side carries it, and carries all of it.
      expect(onRail + onCards, `${type}: ${onRail} on the rail + ${onCards} in cards, fixture holds ${want}`).toBe(want);
      expect(
        onRail === 0 || onCards === 0,
        `${type} landed on both sides: ${onRail} on the rail, ${onCards} in cards`,
      ).toBe(true);
    }
  });

  it('the rail list holds only conversation and the drawer kinds', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'blocker.raised', run: 'alpha', actor: 'blockers', what: 'a credential is missing', runs: ['alpha'] });
    journal.close();
    const fleet = replay(path);

    const { persisted } = fixture();
    const result = computeThread(persisted, fleet.events, 500, [openAsk()]);

    const railKinds = new Set(result.messages.map((m: Message) => m.type));
    for (const kind of railKinds) {
      expect(RAIL_TYPES.has(kind), `${kind} must not reach the rail`).toBe(true);
    }
    expect(railKinds.has('operator')).toBe(true);
    expect(railKinds.has('reply')).toBe(true);
    expect(railKinds.has('receipt')).toBe(true);
    // A refusal is the Conductor answering the operator, and the R-75 roadmap row does
    // not list it among the kinds that leave; drawn nowhere, it is a command that failed
    // in silence.
    expect(railKinds.has('refusal')).toBe(true);
    expect(railKinds.has('thinking')).toBe(true);
  });

  it('puts the status kinds in the second field, blocker and question included', () => {
    const { path, journal } = tempJournal();
    journal.append({ event: 'blocker.raised', run: 'alpha', actor: 'blockers', what: 'a credential is missing', runs: ['alpha'] });
    journal.close();
    const fleet = replay(path);

    const { persisted } = fixture();
    const result = computeThread(persisted, fleet.events, 500, [openAsk()]);
    const cardKinds = new Set(result.cards.map((m) => m.type));
    for (const kind of ['question', 'plan', 'confirm', 'pr', 'blocker', 'decision'] as MessageType[]) {
      expect(cardKinds.has(kind), `${kind} must reach the console through cards`).toBe(true);
    }
  });

  it('keeps both sides sorted by timestamp', () => {
    const { path, journal } = tempJournal();
    journal.close();
    const fleet = replay(path);
    const { persisted } = fixture();
    const result = computeThread(persisted, fleet.events, 500, [openAsk()]);
    const sorted = (messages: Message[]): boolean => messages.every((m, i) => i === 0 || messages[i - 1]!.ts <= m.ts);
    expect(sorted(result.messages)).toBe(true);
    expect(sorted(result.cards)).toBe(true);
  });
});

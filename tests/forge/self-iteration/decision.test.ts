/**
 * Activation is a decision.made row written by a person, mirroring Warden's kill gate
 * exactly (`2026-09-04-forge-warden.md:214-217`). An activation attempt with no matching
 * row is refused; one with a matching row proceeds and journals the evidence. Nothing
 * here ever succeeds on an empty or fabricated decision id.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { replayEvents } from '../../../src/forge/contracts.js';
import { Journal } from '../../../src/forge/journal.js';
import { activate, findActivationDecision } from '../../../src/forge/self-iteration/decision.js';

let home: string;
let journalPath: string;
let journal: Journal;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-self-iteration-decision-'));
  journalPath = join(home, 'fleet.jsonl');
  journal = new Journal(journalPath);
});

describe('activate: refuses without a decision.made row', () => {
  it('refuses on a made-up decision id, journaling permission.denied, never self-iteration.activated', async () => {
    const result = activate({ journal, journalPath }, 'self-iteration', 'made-up-id');
    expect(result.activated).toBe(false);

    const { events } = replayEvents(readFileSync(journalPath, 'utf8'));
    expect(events.some((event) => event.event === 'self-iteration.activated')).toBe(false);
    expect(events.some((event) => event.event === 'permission.denied')).toBe(true);
  });

  it('refuses when the decision names a different target', () => {
    const decision = journal.append({ event: 'decision.made', run: 'some-other-target', actor: 'aaron', action: 'activate', reason: 'wrong target' });
    const result = activate({ journal, journalPath }, 'self-iteration', decision.id);
    expect(result.activated).toBe(false);
  });

  it('refuses when the decision names the right target but a different action', () => {
    const decision = journal.append({ event: 'decision.made', run: 'self-iteration', actor: 'aaron', action: 'kill', reason: 'wrong action' });
    const result = activate({ journal, journalPath }, 'self-iteration', decision.id);
    expect(result.activated).toBe(false);
  });

  it('proceeds and journals the evidence when a matching decision.made row exists', () => {
    const decision = journal.append({
      event: 'decision.made', run: 'self-iteration', actor: 'aaron', action: 'activate', reason: 'the three gates exist now',
    });
    const result = activate({ journal, journalPath }, 'self-iteration', decision.id);
    expect(result.activated).toBe(true);

    const { events } = replayEvents(readFileSync(journalPath, 'utf8'));
    const activated = events.find((event) => event.event === 'self-iteration.activated');
    expect(activated).toBeDefined();
    expect(activated?.['evidence']).toEqual([decision.id]);
  });
});

describe('findActivationDecision', () => {
  it('returns undefined when the journal does not exist yet', () => {
    expect(findActivationDecision(join(home, 'nope.jsonl'), 'self-iteration', 'x')).toBeUndefined();
  });
});

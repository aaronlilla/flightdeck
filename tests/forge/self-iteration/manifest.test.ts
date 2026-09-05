/**
 * F30's remaining part: a decisions manifest for workers, this stream's content only --
 * whether each pending target/action pair already has a decision.made row, and which one.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { Journal } from '../../../src/forge/journal.js';
import { buildDecisionsManifest } from '../../../src/forge/self-iteration/manifest.js';

let home: string;
let journalPath: string;
let journal: Journal;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-self-iteration-manifest-'));
  journalPath = join(home, 'fleet.jsonl');
  journal = new Journal(journalPath);
});

describe('buildDecisionsManifest', () => {
  it('marks a pending target undecided when the journal has no matching row', () => {
    const manifest = buildDecisionsManifest(journalPath, [{ target: 'self-iteration', action: 'activate' }]);
    expect(manifest).toEqual([{ target: 'self-iteration', action: 'activate', decided: false }]);
  });

  it('marks it decided, with the decision id, once a matching row is journaled', () => {
    const decision = journal.append({ event: 'decision.made', run: 'self-iteration', actor: 'aaron', action: 'activate', reason: 'gates exist' });
    const manifest = buildDecisionsManifest(journalPath, [{ target: 'self-iteration', action: 'activate' }]);
    expect(manifest[0]!.decided).toBe(true);
    expect(manifest[0]!.decisionId).toBe(decision.id);
  });

  it('never matches a decision naming a different target or a different action', () => {
    journal.append({ event: 'decision.made', run: 'self-iteration', actor: 'aaron', action: 'kill', reason: 'wrong action' });
    journal.append({ event: 'decision.made', run: 'other-target', actor: 'aaron', action: 'activate', reason: 'wrong target' });
    const manifest = buildDecisionsManifest(journalPath, [{ target: 'self-iteration', action: 'activate' }]);
    expect(manifest[0]!.decided).toBe(false);
  });

  it('returns every pending entry undecided when the journal does not exist yet', () => {
    const manifest = buildDecisionsManifest(join(home, 'nope.jsonl'), [{ target: 'x', action: 'activate' }]);
    expect(manifest).toEqual([{ target: 'x', action: 'activate', decided: false }]);
  });
});

/**
 * forge_gotcha: a worker writes down a trap the moment it hits one.
 *
 * Self-heal is live rather than nightly (Aaron, 2026-09-04). The value is entirely in the
 * timing: a trap recorded a week later is archaeology, and the next agent has already been
 * bitten by it. So the filing worker does not stop, does not wait for a classification,
 * and does not decide whether the gotcha is worth keeping. It writes what happened and
 * carries on.
 *
 * The record has four required fields because a gotcha missing any of them cannot be
 * acted on: what happened, the command or path, the verbatim error, and what would have
 * prevented it. The last one is the one that turns a complaint into a fix.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { Gotchas, classifyGotcha } from '../../src/forge/gotcha.js';
import { replay } from '../../src/forge/journal.js';

let dir: string;
let journalPath: string;
let gotchas: Gotchas;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-gotcha-'));
  journalPath = join(dir, 'fleet.jsonl');
  gotchas = new Gotchas(join(dir, 'gotchas'), journalPath);
});

const TRAP = {
  run: 'alpha',
  what: 'install.ps1 -VerifyOnly ran the installer instead of verifying',
  where: 'dev-harness/install.ps1',
  error: "A parameter cannot be found that matches parameter name 'VerifyOnly'.",
  prevention: 'add [CmdletBinding()] so an unknown flag is an error rather than $args',
};

describe('filing a gotcha', () => {
  it('records it and hands back an id', () => {
    const filed = gotchas.file(TRAP);
    expect(filed.id).toBeTruthy();
    expect(gotchas.all()).toHaveLength(1);
  });

  it('journals it so the cause chain reaches the fix that follows', () => {
    const filed = gotchas.file(TRAP);
    const state = replay(journalPath);
    const row = state.events.find((event) => event.event === 'gotcha');
    expect(row?.['gotcha']).toBe(filed.id);
    expect(row?.run).toBe('alpha');
  });

  it('does not stop the run that filed it', () => {
    expect(gotchas.file(TRAP).disposition).toBe('carry-on');
  });

  it('keeps the error verbatim, which is what makes it searchable', () => {
    const filed = gotchas.file(TRAP);
    expect(readFileSync(join(dir, 'gotchas', `${filed.id}.json`), 'utf8'))
      .toContain("A parameter cannot be found that matches parameter name 'VerifyOnly'.");
  });

  it('refuses a record missing what would have prevented it', () => {
    expect(() => gotchas.file({ ...TRAP, prevention: '' })).toThrow(/prevention/i);
  });

  it('refuses a record with no verbatim error', () => {
    expect(() => gotchas.file({ ...TRAP, error: '   ' })).toThrow(/error/i);
  });

  it('merges a trap already filed rather than growing a pile of duplicates', () => {
    const first = gotchas.file(TRAP);
    const second = gotchas.file({ ...TRAP, run: 'beta' });
    expect(second.id).toBe(first.id);
    expect(second.hits).toBe(2);
    expect(second.runs.sort()).toEqual(['alpha', 'beta']);
    expect(gotchas.all()).toHaveLength(1);
  });
});

describe('what a gotcha is allowed to change', () => {
  it('sends a vault note, a skill or a brief to the fix lane', () => {
    expect(classifyGotcha({ ...TRAP, where: 'boltbetz-docs/70-ops/ops-mobile-release.md' }).lane)
      .toBe('fix');
  });

  it('sends Forge\'s own non-guard code to the fix lane', () => {
    expect(classifyGotcha({ ...TRAP, where: 'flightdeck/src/forge/exec.ts' }).lane).toBe('fix');
  });

  it('holds anything touching a guard for Aaron', () => {
    const verdict = classifyGotcha({ ...TRAP, where: 'dev-harness/hooks/model_gate.py' });
    expect(verdict.lane).toBe('aaron');
    expect(verdict.why).toMatch(/changed by Aaron, not by the fleet/);
  });

  it('holds the model policy for Aaron', () => {
    expect(classifyGotcha({ ...TRAP, where: 'coordination/model-policy.json' }).lane)
      .toBe('aaron');
  });

  it('holds a path it cannot place, rather than guessing it is safe', () => {
    expect(classifyGotcha({ ...TRAP, where: 'somewhere/nobody/declared.bin' }).lane)
      .toBe('aaron');
  });

  it('never sends a guard to the fix lane however the path is written', () => {
    for (const path of [
      'hooks/authorship_guard.py',
      'C:/dev/dev-harness/hooks/gitflow_guard.py',
      'dev-harness\\hooks\\coordination_guard.py',
      'src/forge/model-policy.json',
    ]) {
      const verdict = classifyGotcha({ ...TRAP, where: path });
      expect(verdict.lane, path).toBe('aaron');
      // Matched on the reason's own wording, not on the word "guard": an unplaced path
      // is held too, and its reason echoes the path, so `authorship_guard.py` matched
      // /guard/ and the row stayed green with the guard list emptied.
      expect(verdict.why, path).toMatch(/changed by Aaron, not by the fleet/);
    }
  });
});

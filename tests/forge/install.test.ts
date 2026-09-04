/**
 * Installing Forge on a machine that already has the thing it replaces.
 *
 * Aaron, 2026-09-04: Forge's installer must also uninstall what it supersedes. Two
 * supervisors installed side by side is the failure this whole sub-project exists to
 * avoid, and it is worse than either alone: a lane gets nudged by one and recycled by the
 * other, which is how a goal ended up holding no session at all.
 *
 * Stage B builds the half that looks and refuses. It surveys what the old runtime has on
 * this machine, writes down exactly what would be removed, and refuses to install while
 * the old conductor is still running. Stage C does the removal, from the plan this
 * writes. Splitting it that way means the removal is reviewed as a list before anything
 * is deleted, which is the opposite of what the half-applied install did today.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { planUninstall, surveyOldRuntime, checkInstall } from '../../src/forge/install.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'forge-install-'));
});

/** A machine that has the old runtime installed. */
function withOldRuntime(): string {
  const coordination = join(root, '.claude', 'coordination');
  mkdirSync(coordination, { recursive: true });
  for (const name of ['conductor.py', 'conductor_hooks.py', 'go.py', 'terminals.py',
    'tile.ps1', 'tile-watch.vbs']) {
    writeFileSync(join(coordination, name), '# old runtime\n', 'utf8');
  }
  return coordination;
}

describe('surveying what is already here', () => {
  it('finds nothing on a machine that never had it', () => {
    expect(surveyOldRuntime(root).found).toEqual([]);
    expect(surveyOldRuntime(root).present).toBe(false);
  });

  it('finds the old spawn path when it is installed', () => {
    withOldRuntime();
    const survey = surveyOldRuntime(root);
    expect(survey.present).toBe(true);
    expect(survey.found.map((f) => f.name)).toContain('conductor.py');
    expect(survey.found.map((f) => f.name)).toContain('tile-watch.vbs');
  });

  it('names each file with its full path, so the plan is checkable', () => {
    const coordination = withOldRuntime();
    const survey = surveyOldRuntime(root);
    expect(survey.found[0]?.path.startsWith(coordination)).toBe(true);
  });
});

describe('the uninstall plan', () => {
  it('lists what Stage C will remove and removes nothing itself', () => {
    withOldRuntime();
    const plan = planUninstall(root);

    expect(plan.remove.length).toBeGreaterThan(0);
    // Still on disk. This step writes a list; the removal is reviewed first.
    expect(surveyOldRuntime(root).present).toBe(true);
  });

  it('says what replaces each thing it would remove', () => {
    withOldRuntime();
    for (const item of planUninstall(root).remove) {
      expect(item.replacedBy, item.path).toBeTruthy();
    }
  });

  it('is written where a person can read it before agreeing to it', () => {
    withOldRuntime();
    const plan = planUninstall(root, join(root, 'uninstall-plan.json'));
    const written = JSON.parse(readFileSync(join(root, 'uninstall-plan.json'), 'utf8'));
    expect(written.remove).toHaveLength(plan.remove.length);
  });

  it('is empty on a machine that never had the old runtime', () => {
    expect(planUninstall(root).remove).toEqual([]);
  });

  it('never proposes removing the hooks a running worker is using', () => {
    withOldRuntime();

    // The survey has to see it first, or the exclusion is unreachable and this row
    // proves nothing. conductor_hooks.py matches the conductor pattern, so it does.
    const survey = surveyOldRuntime(root).found.map((file) => file.name);
    expect(survey).toContain('conductor_hooks.py');

    const paths = planUninstall(root).remove.map((item) => item.path);
    expect(paths.some((path) => path.includes('conductor_hooks.py'))).toBe(false);
  });

  it('does not survey the model policy at all, so it cannot propose removing it', () => {
    const coordination = withOldRuntime();
    writeFileSync(join(coordination, 'model-policy.json'), '{}', 'utf8');
    writeFileSync(join(coordination, 'model_policy.py'), '# policy', 'utf8');

    // Two defences, and only the first is exercised. The survey never matches these
    // names, so the exclusion list's policy patterns are cover for a future widening of
    // the survey rather than something this suite proves today. Saying that beats a
    // green row that implies otherwise.
    const survey = surveyOldRuntime(root).found.map((file) => file.name);
    expect(survey).not.toContain('model-policy.json');
    expect(survey).not.toContain('model_policy.py');
  });
});

describe('refusing to install', () => {
  it('refuses while the old conductor is still running', () => {
    withOldRuntime();
    const verdict = checkInstall(root, { conductorRunning: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.refusals.join(' ')).toMatch(/conductor is running/i);
  });

  it('allows it once the old conductor has stopped', () => {
    withOldRuntime();
    expect(checkInstall(root, { conductorRunning: false }).ok).toBe(true);
  });

  it('warns that the old runtime is present so it is not installed alongside quietly', () => {
    withOldRuntime();
    const verdict = checkInstall(root, { conductorRunning: false });
    expect(verdict.notes.join(' ')).toMatch(/uninstall/i);
  });

  it('is quiet on a clean machine', () => {
    const verdict = checkInstall(root, { conductorRunning: false });
    expect(verdict.ok).toBe(true);
    expect(verdict.notes).toEqual([]);
  });
});

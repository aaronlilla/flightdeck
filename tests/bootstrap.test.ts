/**
 * Bootstrap is the piece the whole cross-machine story rests on, and it was
 * listed as an unproven assumption in the founding spec. These tests create
 * real links on the real filesystem and read through them, because a mocked
 * filesystem would prove the code calls symlink and nothing about whether a
 * junction works on this machine.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { apply, inspect, planFor, verify } from '../src/bootstrap/links.ts';

let root: string;
let repo: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'flightdeck-bootstrap-'));
  repo = path.join(root, 'repo');
  home = path.join(root, 'home');
  for (const dir of ['skills', 'agents', 'commands']) {
    mkdirSync(path.join(repo, 'doctrine', dir), { recursive: true });
  }
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(repo, 'doctrine', 'skills', 'marker.md'), 'from the repo\n');
  writeFileSync(path.join(repo, 'doctrine', 'CLAUDE.md'), '# doctrine\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('bootstrap', () => {
  it('reports everything missing before it runs', () => {
    const reports = verify(planFor(repo, home));
    expect(reports.map((r) => r.status)).toEqual(['missing', 'missing', 'missing', 'missing']);
  });

  it('creates links that read through to the repository', () => {
    const reports = apply(planFor(repo, home));
    expect(reports.every((r) => r.status === 'ok')).toBe(true);

    // The actual claim: content edited in the repo is visible under the Claude
    // home without anything being copied.
    const throughLink = readFileSync(path.join(home, '.claude', 'skills', 'marker.md'), 'utf8');
    expect(throughLink).toBe('from the repo\n');
  });

  it('shows an edit in the repository immediately through the link', () => {
    apply(planFor(repo, home));
    writeFileSync(path.join(repo, 'doctrine', 'skills', 'marker.md'), 'edited\n');
    const throughLink = readFileSync(path.join(home, '.claude', 'skills', 'marker.md'), 'utf8');
    expect(throughLink).toBe('edited\n');
  });

  it('is safe to run twice', () => {
    apply(planFor(repo, home));
    const second = apply(planFor(repo, home));
    expect(second.every((r) => r.status === 'ok')).toBe(true);
  });

  it('notices a link that was repointed somewhere else', () => {
    const plans = planFor(repo, home);
    apply(plans);
    const other = path.join(root, 'elsewhere');
    mkdirSync(other, { recursive: true });
    const skills = plans[0]!;
    apply([{ ...skills, source: other }]);
    expect(inspect(skills).status).toBe('wrong-target');
  });

  it('refuses to delete a real directory sitting where a link belongs', () => {
    const plans = planFor(repo, home);
    const skills = plans[0]!;
    mkdirSync(skills.target, { recursive: true });
    writeFileSync(path.join(skills.target, 'someone-elses.md'), 'do not lose me\n');

    const report = apply([skills]);
    expect(report[0]?.status).toBe('occupied');
    // The point of refusing: the existing content is still there.
    expect(readFileSync(path.join(skills.target, 'someone-elses.md'), 'utf8')).toBe(
      'do not lose me\n',
    );
  });

  it('replaces an occupied directory only when told to', () => {
    const plans = planFor(repo, home);
    const skills = plans[0]!;
    mkdirSync(skills.target, { recursive: true });
    const report = apply([skills], { force: true });
    expect(report[0]?.status).toBe('ok');
  });

  it('notices a copied file that drifted from the repository', () => {
    const plans = planFor(repo, home);
    apply(plans);
    const claudeMd = plans[3]!;
    writeFileSync(claudeMd.target, '# edited by hand\n');
    expect(inspect(claudeMd).status).toBe('stale-copy');
  });

  it('reports a missing source rather than creating a broken link', () => {
    const plans = planFor(repo, home);
    rmSync(path.join(repo, 'doctrine', 'agents'), { recursive: true, force: true });
    const reports = apply(plans);
    const agents = reports.find((r) => r.plan.target.endsWith('agents'));
    expect(agents?.status).toBe('source-missing');
  });
});

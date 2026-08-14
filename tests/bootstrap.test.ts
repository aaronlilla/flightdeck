/**
 * Bootstrap carries the whole cross-machine story, and the founding spec listed
 * it as an unproven assumption. These tests create real links on a real
 * filesystem and read through them. A mocked filesystem would only prove the
 * code calls symlink, not that a junction works on this machine.
 *
 * Bootstrap links one entry at a time into ~/.claude/skills and leaves the rest
 * of that directory alone. An earlier version replaced the directory wholesale
 * with a single junction, which destroyed every skill the machine had and the
 * repo did not as soon as anyone passed --force. Most of what follows pins down
 * what bootstrap must not touch.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { apply, inspect, isSettled, planFor, verify } from '../src/bootstrap/links.ts';
import { applySettings, inspectSettings, settingsPlan } from '../src/bootstrap/settings.ts';

let root: string;
let repo: string;
let home: string;

/** A skill is a directory with a SKILL.md in it. */
function makeSkill(base: string, name: string, body: string): void {
  mkdirSync(path.join(base, name), { recursive: true });
  writeFileSync(path.join(base, name, 'SKILL.md'), body);
}

function repoSkills(): string {
  return path.join(repo, 'doctrine', 'skills');
}

function homeSkills(): string {
  return path.join(home, '.claude', 'skills');
}

function reportFor(reports: ReturnType<typeof verify>, name: string) {
  return reports.find((r) => path.basename(r.plan.target) === name);
}

const linkDir = (source: string, target: string) =>
  symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'flightdeck-bootstrap-'));
  repo = path.join(root, 'repo');
  home = path.join(root, 'home');
  mkdirSync(repoSkills(), { recursive: true });
  mkdirSync(home, { recursive: true });
  makeSkill(repoSkills(), 'from-repo', 'repo skill\n');
  writeFileSync(path.join(repo, 'doctrine', 'CLAUDE.md'), '# doctrine\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('bootstrap merges rather than replaces', () => {
  it('links each repo skill as its own entry inside a real directory', () => {
    apply(planFor(repo, home));

    expect(lstatSync(homeSkills()).isSymbolicLink()).toBe(false);
    expect(lstatSync(path.join(homeSkills(), 'from-repo')).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(homeSkills(), 'from-repo', 'SKILL.md'), 'utf8')).toBe(
      'repo skill\n',
    );
  });

  it('leaves a skill the machine has and the repo does not completely alone', () => {
    makeSkill(homeSkills(), 'machine-only', 'do not lose me\n');

    const reports = apply(planFor(repo, home));

    expect(reportFor(reports, 'machine-only')?.status).toBe('machine-only');
    expect(readFileSync(path.join(homeSkills(), 'machine-only', 'SKILL.md'), 'utf8')).toBe(
      'do not lose me\n',
    );
    expect(lstatSync(path.join(homeSkills(), 'machine-only')).isSymbolicLink()).toBe(false);
  });

  it('leaves a machine version of a name the checkout also has', () => {
    // The machine's copy of a skill is there for a reason nobody has written
    // down. The checkout does not get to guess what that reason was.
    makeSkill(homeSkills(), 'from-repo', 'the machine version\n');

    const reports = apply(planFor(repo, home));

    expect(reportFor(reports, 'from-repo')?.status).toBe('machine-differs');
    expect(readFileSync(path.join(homeSkills(), 'from-repo', 'SKILL.md'), 'utf8')).toBe(
      'the machine version\n',
    );
  });

  it('treats the machine winning as a finished state rather than a failure', () => {
    // Nothing is outstanding here, so nothing should nag. A run that reports a
    // problem every time teaches people to stop reading it.
    makeSkill(homeSkills(), 'from-repo', 'the machine version\n');
    makeSkill(homeSkills(), 'machine-only', 'do not lose me\n');

    const reports = apply(planFor(repo, home));

    expect(reports.filter((r) => !isSettled(r.status))).toEqual([]);
  });

  it('offers no way at all to overwrite what the machine has', () => {
    // The guarantee is structural. apply() takes no option that replaces a
    // machine copy, so no caller and no flag can ask for it.
    makeSkill(homeSkills(), 'from-repo', 'the machine version\n');
    makeSkill(homeSkills(), 'machine-only', 'do not lose me\n');

    // Every call shape the module accepts, run twice for good measure.
    apply(planFor(repo, home));
    apply(planFor(repo, home));

    expect(readFileSync(path.join(homeSkills(), 'from-repo', 'SKILL.md'), 'utf8')).toBe(
      'the machine version\n',
    );
    expect(readFileSync(path.join(homeSkills(), 'machine-only', 'SKILL.md'), 'utf8')).toBe(
      'do not lose me\n',
    );
    expect(apply.length).toBe(1);
  });

  it('links a colliding entry without --force when the content already matches', () => {
    makeSkill(homeSkills(), 'from-repo', 'repo skill\n');

    const reports = apply(planFor(repo, home));

    expect(reportFor(reports, 'from-repo')?.status).toBe('ok');
    expect(lstatSync(path.join(homeSkills(), 'from-repo')).isSymbolicLink()).toBe(true);
  });

  it('treats a machine copy that differs only in line endings as the same content', () => {
    // A skill the machine got by cloning on Windows carries CRLF where the
    // checkout holds LF. That is how the file was written to disk, not what it
    // says, and making it a collision would strand it behind --force forever.
    makeSkill(homeSkills(), 'from-repo', 'repo skill\r\n');

    const reports = apply(planFor(repo, home));

    expect(reportFor(reports, 'from-repo')?.status).toBe('ok');
    expect(lstatSync(path.join(homeSkills(), 'from-repo')).isSymbolicLink()).toBe(true);
  });

  it('migrates the old whole-directory junction to per-entry links', () => {
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    linkDir(repoSkills(), homeSkills());
    expect(lstatSync(homeSkills()).isSymbolicLink()).toBe(true);

    apply(planFor(repo, home));

    expect(lstatSync(homeSkills()).isSymbolicLink()).toBe(false);
    expect(lstatSync(path.join(homeSkills(), 'from-repo')).isSymbolicLink()).toBe(true);
    expect(readFileSync(path.join(homeSkills(), 'from-repo', 'SKILL.md'), 'utf8')).toBe(
      'repo skill\n',
    );
  });

  it('does not mistake repo content seen through the old junction for machine skills', () => {
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    linkDir(repoSkills(), homeSkills());
    const reports = apply(planFor(repo, home));
    expect(reports.filter((r) => r.status === 'machine-only')).toEqual([]);
  });

  it('clears a dangling link left by a skill the repo dropped', () => {
    mkdirSync(homeSkills(), { recursive: true });
    const gone = path.join(root, 'deleted-skill');
    mkdirSync(gone, { recursive: true });
    linkDir(gone, path.join(homeSkills(), 'was-in-repo'));
    rmSync(gone, { recursive: true, force: true });

    apply(planFor(repo, home));

    expect(existsSync(path.join(homeSkills(), 'was-in-repo'))).toBe(false);
  });

  it('keeps a live link the machine points somewhere of its own', () => {
    mkdirSync(homeSkills(), { recursive: true });
    const elsewhere = path.join(root, 'elsewhere');
    makeSkill(elsewhere, 'nested', 'someone elses link\n');
    linkDir(path.join(elsewhere, 'nested'), path.join(homeSkills(), 'borrowed'));

    apply(planFor(repo, home));

    expect(readFileSync(path.join(homeSkills(), 'borrowed', 'SKILL.md'), 'utf8')).toBe(
      'someone elses link\n',
    );
  });
});

describe('bootstrap link mechanics', () => {
  it('shows an edit in the repository immediately through the link', () => {
    apply(planFor(repo, home));
    writeFileSync(path.join(repoSkills(), 'from-repo', 'SKILL.md'), 'edited\n');
    expect(readFileSync(path.join(homeSkills(), 'from-repo', 'SKILL.md'), 'utf8')).toBe('edited\n');
  });

  it('is safe to run twice', () => {
    apply(planFor(repo, home));
    const second = apply(planFor(repo, home));
    expect(second.filter((r) => !isSettled(r.status))).toEqual([]);
  });

  it('repoints a link aimed at a stale checkout', () => {
    apply(planFor(repo, home));
    const link = path.join(homeSkills(), 'from-repo');
    rmSync(link, { recursive: true, force: true });
    const stale = path.join(root, 'old-checkout');
    mkdirSync(stale, { recursive: true });
    linkDir(stale, link);

    expect(reportFor(verify(planFor(repo, home)), 'from-repo')?.status).toBe('wrong-target');
    apply(planFor(repo, home));
    expect(readFileSync(path.join(link, 'SKILL.md'), 'utf8')).toBe('repo skill\n');
  });

  it('copies a loose file rather than linking it, because file links need elevation', () => {
    writeFileSync(path.join(repoSkills(), 'loose.md'), 'loose\n');
    apply(planFor(repo, home));
    const copied = path.join(homeSkills(), 'loose.md');
    expect(lstatSync(copied).isSymbolicLink()).toBe(false);
    expect(readFileSync(copied, 'utf8')).toBe('loose\n');
  });

  it('notices a copied file that drifted from the repository', () => {
    const plans = planFor(repo, home);
    apply(plans);
    const claudeMd = plans.find((p) => path.basename(p.target) === 'CLAUDE.md')!;
    writeFileSync(claudeMd.target, '# edited by hand\n');
    expect(inspect(claudeMd).status).toBe('stale-copy');
  });

  it('reports a missing source rather than creating a broken link', () => {
    const agents = verify(planFor(repo, home)).find((r) => r.plan.target.endsWith('agents'));
    expect(agents?.status).toBe('source-missing');
  });
});

describe('portable settings merge', () => {
  const settingsPath = () => path.join(home, '.claude', 'settings.json');

  function writePortable(body: unknown): void {
    writeFileSync(path.join(repo, 'doctrine', 'settings.portable.json'), JSON.stringify(body));
  }

  function writeSettings(body: unknown): void {
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(body, null, 2));
  }

  function readSettings(): Record<string, unknown> {
    return JSON.parse(readFileSync(settingsPath(), 'utf8'));
  }

  it('adds plugins the machine does not have yet', () => {
    writePortable({ enabledPlugins: { 'superpowers@official': true } });
    writeSettings({ enabledPlugins: {} });

    const report = applySettings(settingsPlan(repo, home));

    expect(report.added).toContain('enabledPlugins.superpowers@official');
    expect(readSettings().enabledPlugins).toEqual({ 'superpowers@official': true });
  });

  it('creates the settings file when the machine has none', () => {
    writePortable({ enabledPlugins: { 'superpowers@official': true } });
    mkdirSync(path.join(home, '.claude'), { recursive: true });

    applySettings(settingsPlan(repo, home));

    expect(readSettings().enabledPlugins).toEqual({ 'superpowers@official': true });
  });

  it('never overwrites a decision the machine already made', () => {
    // A plugin that was deliberately switched off stays off. The repo declares
    // intent for a fresh machine. It does not overrule a configured one.
    writePortable({ enabledPlugins: { 'superpowers@official': true } });
    writeSettings({ enabledPlugins: { 'superpowers@official': false } });

    const report = applySettings(settingsPlan(repo, home));

    expect(report.added).toEqual([]);
    expect(readSettings().enabledPlugins).toEqual({ 'superpowers@official': false });
  });

  it('never removes a plugin the machine has and the repo does not', () => {
    writePortable({ enabledPlugins: { 'superpowers@official': true } });
    writeSettings({ enabledPlugins: { 'local-only@somewhere': true } });

    applySettings(settingsPlan(repo, home));

    expect(readSettings().enabledPlugins).toEqual({
      'local-only@somewhere': true,
      'superpowers@official': true,
    });
  });

  it('leaves every unrelated key exactly as it found it', () => {
    writePortable({ enabledPlugins: { 'superpowers@official': true } });
    writeSettings({ model: 'opus', hooks: { PreToolUse: ['guard'] }, enabledPlugins: {} });

    applySettings(settingsPlan(repo, home));

    const after = readSettings();
    expect(after.model).toBe('opus');
    expect(after.hooks).toEqual({ PreToolUse: ['guard'] });
  });

  it('merges marketplaces the same additive way', () => {
    writePortable({
      extraKnownMarketplaces: { sp: { source: { source: 'github', repo: 'obra/x' } } },
    });
    writeSettings({ extraKnownMarketplaces: { mine: { source: { source: 'github', repo: 'a/b' } } } });

    applySettings(settingsPlan(repo, home));

    expect(Object.keys(readSettings().extraKnownMarketplaces as object).sort()).toEqual([
      'mine',
      'sp',
    ]);
  });

  it('carries a plugin opt-out switch alongside the plugin it belongs to', () => {
    writePortable({
      enabledPlugins: { 'impeccable@impeccable': true },
      env: { IMPECCABLE_NO_TELEMETRY: '1' },
    });
    writeSettings({});

    applySettings(settingsPlan(repo, home));

    expect(readSettings().env).toEqual({ IMPECCABLE_NO_TELEMETRY: '1' });
  });

  it('reports the portable file missing instead of throwing', () => {
    expect(inspectSettings(settingsPlan(repo, home)).status).toBe('source-missing');
  });

  it('reports nothing to do once the machine already matches', () => {
    writePortable({ enabledPlugins: { 'superpowers@official': true } });
    writeSettings({ enabledPlugins: { 'superpowers@official': true } });

    const report = applySettings(settingsPlan(repo, home));

    expect(report.status).toBe('ok');
    expect(report.added).toEqual([]);
    expect(report.alreadyPresent).toContain('enabledPlugins.superpowers@official');
  });

  it('does not corrupt the file when the machine settings are not valid json', () => {
    writePortable({ enabledPlugins: { 'superpowers@official': true } });
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), '{ this is not json');

    const report = applySettings(settingsPlan(repo, home));

    expect(report.status).toBe('unreadable');
    expect(readFileSync(settingsPath(), 'utf8')).toBe('{ this is not json');
  });
});

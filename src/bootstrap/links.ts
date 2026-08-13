/**
 * Bootstrap: one clone is the whole setup, and git is the sync.
 *
 * The installer this replaces copied files into ~/.claude and verified them by
 * hash, then grew a backup system, a merge system and a drift detector to
 * manage the problems copying creates. Links make copy drift structurally
 * impossible instead of merely detectable, so verification shrinks to asking
 * whether the link still points where it should.
 *
 * Directories are linked. Windows creates a junction for those, which needs no
 * administrator rights, while other platforms get an ordinary directory
 * symlink. Single files are copied and hashed instead, because a file symlink
 * on Windows does require elevation or developer mode, and a bootstrap that
 * demands an elevated shell is a bootstrap that does not get run.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LinkKind = 'link' | 'copy';

export interface Plan {
  /** Path inside the repository that holds the real content. */
  source: string;
  /** Path under the Claude home that should point at it. */
  target: string;
  kind: LinkKind;
}

export type Status = 'ok' | 'missing' | 'wrong-target' | 'stale-copy' | 'occupied' | 'source-missing';

export interface Report {
  plan: Plan;
  status: Status;
  detail: string;
}

export function claudeHome(home = os.homedir()): string {
  return path.join(home, '.claude');
}

/**
 * What bootstrap wires up. Skills, agents and commands are directories the
 * engine reads by convention, so linking them makes an edit in the repository
 * live everywhere at once.
 */
export function planFor(repoRoot: string, home = os.homedir()): Plan[] {
  const doctrine = path.join(repoRoot, 'doctrine');
  const claude = claudeHome(home);
  return [
    { source: path.join(doctrine, 'skills'), target: path.join(claude, 'skills'), kind: 'link' },
    { source: path.join(doctrine, 'agents'), target: path.join(claude, 'agents'), kind: 'link' },
    { source: path.join(doctrine, 'commands'), target: path.join(claude, 'commands'), kind: 'link' },
    { source: path.join(doctrine, 'CLAUDE.md'), target: path.join(claude, 'CLAUDE.md'), kind: 'copy' },
  ];
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

/** Inspect one entry without changing anything. */
export function inspect(plan: Plan): Report {
  if (!existsSync(plan.source)) {
    return { plan, status: 'source-missing', detail: `nothing at ${plan.source}` };
  }
  if (!existsSync(plan.target)) {
    let stat;
    try {
      stat = lstatSync(plan.target);
    } catch {
      stat = null;
    }
    // A dangling link still exists as a link even though existsSync follows it.
    if (stat?.isSymbolicLink()) {
      return { plan, status: 'wrong-target', detail: 'link points at something that is gone' };
    }
    return { plan, status: 'missing', detail: 'not created yet' };
  }

  const stat = lstatSync(plan.target);

  if (plan.kind === 'link') {
    if (!stat.isSymbolicLink()) {
      return {
        plan,
        status: 'occupied',
        detail: 'a real directory sits where the link belongs, so its contents would be lost',
      };
    }
    const actual = readlinkSync(plan.target);
    return samePath(actual, plan.source)
      ? { plan, status: 'ok', detail: 'linked' }
      : { plan, status: 'wrong-target', detail: `points at ${actual}` };
  }

  return sha256(plan.source) === sha256(plan.target)
    ? { plan, status: 'ok', detail: 'copy matches' }
    : { plan, status: 'stale-copy', detail: 'copy differs from the repository' };
}

export function verify(plans: Plan[]): Report[] {
  return plans.map(inspect);
}

export interface ApplyOptions {
  /**
   * Replace a real directory sitting where a link belongs. Off by default: that
   * directory is somebody's existing setup, and silently deleting it is the
   * kind of help nobody asks for twice.
   */
  force?: boolean;
}

export function apply(plans: Plan[], options: ApplyOptions = {}): Report[] {
  const out: Report[] = [];
  for (const plan of plans) {
    const before = inspect(plan);
    if (before.status === 'ok' || before.status === 'source-missing') {
      out.push(before);
      continue;
    }
    if (before.status === 'occupied' && !options.force) {
      out.push(before);
      continue;
    }

    mkdirSync(path.dirname(plan.target), { recursive: true });
    if (existsSync(plan.target) || isLink(plan.target)) {
      rmSync(plan.target, { recursive: true, force: true });
    }

    if (plan.kind === 'link') {
      // 'junction' on Windows needs no elevation. Everywhere else a directory
      // symlink is the equivalent.
      symlinkSync(plan.source, plan.target, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      copyFileSync(plan.source, plan.target);
    }
    out.push(inspect(plan));
  }
  return out;
}

function isLink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

export function describe(reports: Report[]): string {
  return reports
    .map((r) => {
      const name = path.basename(r.plan.target);
      return `  ${r.status === 'ok' ? 'ok  ' : 'FAIL'}  ${name.padEnd(12)} ${r.detail}`;
    })
    .join('\n');
}

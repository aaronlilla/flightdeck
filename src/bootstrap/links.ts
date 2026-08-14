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
 *
 * Linking happens one entry at a time. ~/.claude/skills stays a real directory
 * holding a junction per skill in the checkout, beside whatever else the
 * machine already had. Pointing a single junction at the whole directory is a
 * shorter piece of code, and it means the checkout defines not just what the
 * machine gets but what it is allowed to keep. A machine accumulates skills
 * from plugins, from experiments and from other people, and a setup step that
 * deletes them is a setup step nobody runs twice.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LinkKind = 'link' | 'copy' | 'container';

export interface Plan {
  /** Which merged directory this belongs to: `skills`, `agents`, `commands`, or '' for loose files. */
  group: string;
  /** How to name it in a report. */
  name: string;
  /** Path inside the checkout that holds the real content, or null when only the machine has it. */
  source: string | null;
  /** Path under the Claude home. */
  target: string;
  kind: LinkKind;
}

export type Status =
  | 'ok'
  | 'missing'
  | 'wrong-target'
  | 'stale-copy'
  | 'identical'
  | 'machine-differs'
  | 'machine-only'
  | 'legacy-link'
  | 'source-missing';

export interface Report {
  plan: Plan;
  status: Status;
  detail: string;
}

/**
 * Statuses that are a finished state rather than work outstanding. A skill the
 * machine has to itself and one it has its own version of are both finished:
 * the machine's copy stands, that is the whole answer, and a run that reported
 * it as a problem every time would train people to stop reading the output.
 */
const SETTLED: ReadonlySet<Status> = new Set<Status>([
  'ok',
  'machine-only',
  'machine-differs',
  'source-missing',
]);

export function isSettled(status: Status): boolean {
  return SETTLED.has(status);
}

export function claudeHome(home = os.homedir()): string {
  return path.join(home, '.claude');
}

/** The directories the engine reads by convention, merged rather than replaced. */
const MERGED = ['skills', 'agents', 'commands'] as const;

/**
 * What bootstrap wires up. Each merged directory contributes one plan for the
 * directory itself and one per entry inside it, so a single skill can be linked,
 * skipped or left alone without involving its neighbours.
 */
export function planFor(repoRoot: string, home = os.homedir()): Plan[] {
  const doctrine = path.join(repoRoot, 'doctrine');
  const claude = claudeHome(home);
  const plans: Plan[] = [];

  for (const group of MERGED) {
    plans.push(...mergePlans(path.join(doctrine, group), path.join(claude, group), group));
  }

  plans.push({
    group: '',
    name: 'CLAUDE.md',
    source: path.join(doctrine, 'CLAUDE.md'),
    target: path.join(claude, 'CLAUDE.md'),
    kind: 'copy',
  });
  return plans;
}

function mergePlans(sourceDir: string, targetDir: string, group: string): Plan[] {
  const plans: Plan[] = [
    { group, name: `${group}/`, source: sourceDir, target: targetDir, kind: 'container' },
  ];
  if (!existsSync(sourceDir)) return plans;

  const fromRepo = readdirSync(sourceDir);
  for (const name of fromRepo) {
    const source = path.join(sourceDir, name);
    plans.push({
      group,
      name,
      source,
      target: path.join(targetDir, name),
      kind: isDirectory(source) ? 'link' : 'copy',
    });
  }

  // Anything the machine has that the checkout does not. Skipped while the
  // target is still the old whole-directory junction, because everything
  // visible through it belongs to the checkout and none of it is the machine's.
  if (existsSync(targetDir) && !isLink(targetDir)) {
    const known = new Set(fromRepo);
    for (const name of readdirSync(targetDir)) {
      if (known.has(name)) continue;
      plans.push({
        group,
        name,
        source: null,
        target: path.join(targetDir, name),
        kind: 'link',
      });
    }
  }
  return plans;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

function isLink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Compare two files by what they say. Identical bytes settle it. Failing that,
 * a file the machine cloned on Windows can hold CRLF where the checkout holds
 * LF, which is a fact about how it reached the disk rather than about its
 * content, so text is compared again with newlines normalized. Anything that is
 * not valid UTF-8 is left to the byte comparison.
 */
function sameFile(a: string, b: string): boolean {
  const bytesA = readFileSync(a);
  const bytesB = readFileSync(b);
  if (bytesA.equals(bytesB)) return true;

  const asText = (bytes: Buffer): string | null => {
    const text = bytes.toString('utf8');
    return Buffer.from(text, 'utf8').equals(bytes) ? text.replace(/\r\n/g, '\n') : null;
  };
  const textA = asText(bytesA);
  const textB = asText(bytesB);
  return textA !== null && textA === textB;
}

/**
 * Compare two trees by content. `.git` is skipped: a skill vendored from a clone
 * carries one and the copy in the checkout cannot, since a nested repository
 * would confuse git, and version history is not part of what the skill does.
 */
function sameTree(a: string, b: string): boolean {
  const dirA = isDirectory(a);
  if (dirA !== isDirectory(b)) return false;
  if (!dirA) return sameFile(a, b);

  const entries = (dir: string) =>
    readdirSync(dir)
      .filter((name) => name !== '.git')
      .sort();
  const listA = entries(a);
  const listB = entries(b);
  if (listA.length !== listB.length) return false;
  if (listA.some((name, i) => name !== listB[i])) return false;
  return listA.every((name) => sameTree(path.join(a, name), path.join(b, name)));
}

/** Inspect one entry without changing anything. */
export function inspect(plan: Plan): Report {
  if (plan.source === null) return inspectMachineOnly(plan);

  if (!existsSync(plan.source)) {
    return { plan, status: 'source-missing', detail: `nothing at ${plan.source}` };
  }

  if (plan.kind === 'container') {
    if (isLink(plan.target)) {
      return { plan, status: 'legacy-link', detail: 'one junction covers the whole directory' };
    }
    return existsSync(plan.target)
      ? { plan, status: 'ok', detail: 'directory ready' }
      : { plan, status: 'missing', detail: 'not created yet' };
  }

  if (!existsSync(plan.target)) {
    // A dangling link still exists as a link even though existsSync follows it.
    return isLink(plan.target)
      ? { plan, status: 'wrong-target', detail: 'link points at something that is gone' }
      : { plan, status: 'missing', detail: 'not created yet' };
  }

  if (plan.kind === 'link') {
    if (isLink(plan.target)) {
      const actual = readlinkSync(plan.target);
      return samePath(actual, plan.source)
        ? { plan, status: 'ok', detail: 'linked' }
        : { plan, status: 'wrong-target', detail: `points at ${actual}` };
    }
    if (isDirectory(plan.target) && sameTree(plan.source, plan.target)) {
      return { plan, status: 'identical', detail: 'same content already, safe to link' };
    }
    return {
      plan,
      status: 'machine-differs',
      detail: 'the machine has its own version, which stands',
    };
  }

  return sha256(plan.source) === sha256(plan.target)
    ? { plan, status: 'ok', detail: 'copy matches' }
    : { plan, status: 'stale-copy', detail: 'copy differs from the checkout' };
}

function inspectMachineOnly(plan: Plan): Report {
  if (!existsSync(plan.target)) {
    return isLink(plan.target)
      ? { plan, status: 'wrong-target', detail: 'link left over from a checkout that is gone' }
      : { plan, status: 'ok', detail: 'cleared' };
  }
  return { plan, status: 'machine-only', detail: 'the machine has this, so it was left alone' };
}

export function verify(plans: Plan[]): Report[] {
  return plans.map(inspect);
}

/**
 * Wire up everything the checkout owns and nothing else.
 *
 * There is deliberately no option to replace what the machine has. A flag for
 * it would be used, and the reason a machine's copy of a skill differs is
 * usually written down nowhere: somebody amended it for a job the checkout has
 * never heard of. Anyone who genuinely wants the checkout's version can delete
 * their own directory and run this again, which is a decision made in the open
 * rather than a flag that quietly did it.
 */
export function apply(plans: Plan[]): Report[] {
  const out: Report[] = [];
  // Containers come first out of planFor, so a directory is real before anything
  // is written inside it.
  for (const plan of plans) {
    const before = inspect(plan);

    // Everything settled is either already right or the machine's business.
    if (isSettled(before.status)) {
      out.push(before);
      continue;
    }

    if (plan.kind === 'container') {
      // Removing a junction removes the link and never the directory it points at.
      if (before.status === 'legacy-link') rmSync(plan.target, { recursive: true, force: true });
      mkdirSync(plan.target, { recursive: true });
      out.push(inspect(plan));
      continue;
    }

    if (plan.source === null) {
      // The only machine entry worth touching: a dead link this tool left behind.
      rmSync(plan.target, { recursive: true, force: true });
      out.push(inspect(plan));
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

const HEADINGS: Partial<Record<Status, string>> = {
  ok: 'linked',
  'machine-only': 'kept',
  'machine-differs': 'kept, yours differs',
  missing: 'to create',
  identical: 'to link',
  'wrong-target': 'to repoint',
  'stale-copy': 'to refresh',
  'legacy-link': 'to migrate',
  'source-missing': 'not in the checkout',
};

function headingFor(report: Report): string {
  // A copied file is never linked, and saying so would be a small lie in the one
  // place a reader is checking what the tool actually did.
  if (report.status === 'ok' && report.plan.kind === 'copy') return 'copied';
  return HEADINGS[report.status] ?? report.status;
}

/**
 * An accounting of what happened per directory. The point is that a run which
 * declines to do something says which entries and why, rather than reporting one
 * verdict for a directory holding thirty unrelated things.
 */
export function describe(reports: Report[]): string {
  const groups = new Map<string, Report[]>();
  for (const report of reports) {
    if (report.plan.kind === 'container' && report.status === 'ok') continue;
    const key = report.plan.group || 'files';
    const bucket = groups.get(key);
    if (bucket) bucket.push(report);
    else groups.set(key, [report]);
  }

  const lines: string[] = [];
  for (const [group, bucket] of groups) {
    lines.push(`  ${group}`);
    const byHeading = new Map<string, { settled: boolean; names: string[] }>();
    for (const report of bucket) {
      const heading = headingFor(report);
      const entry = byHeading.get(heading);
      if (entry) entry.names.push(report.plan.name);
      else byHeading.set(heading, { settled: isSettled(report.status), names: [report.plan.name] });
    }
    for (const [heading, { settled, names }] of byHeading) {
      const mark = settled ? ' ' : '!';
      lines.push(
        `   ${mark} ${heading.padEnd(20)} ${String(names.length).padStart(3)}  ${names.join(', ')}`,
      );
    }
  }
  return lines.join('\n');
}

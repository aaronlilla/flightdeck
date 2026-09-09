/**
 * Contamination check: nothing project specific or machine specific may be
 * committed to this repository.
 *
 * The old harness leaked employer hook names, drive-rooted development
 * directories, and absolute home directories into a repo that was supposed to
 * be portable. Its own planned check would have caught the first two and
 * missed the third, so this one covers absolute home paths as a first class
 * pattern.
 *
 * The patterns are assembled from fragments at run time. Writing them as
 * literals would make this file match itself, and the usual fix for that is to
 * exempt the checker, which creates exactly the blind spot the checker exists
 * to remove.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

const join = (...parts: string[]) => parts.join('');

/**
 * Employer and project names that must never appear here. Assembled from
 * fragments so this source stays clean of the strings it looks for.
 */
const PROJECT_WORDS = [
  join('bolt', 'betz'),
  join('bb', '-infra'),
  join('bb', 'management'),
  join('v2-', 'react-', 'native'),
  join('holo', 'scene'),
];

/** Absolute paths that only exist on one machine. */
const PATH_RULES: Array<{ rule: string; re: RegExp }> = [
  {
    rule: 'windows-dev-root',
    // A drive-rooted dev directory, which is where the old coordination
    // library assumed every repository lived.
    re: /\bc:[/\\]dev\b/i,
  },
  {
    rule: 'absolute-home-windows',
    // The leak class the old plan's pattern would have missed. Separators
    // repeat because source code escapes backslashes, so a path embedded in a
    // string literal carries two of them on disk. Angle brackets are excluded
    // so that documentation writing a placeholder in <name> form is not
    // reported as a real path.
    re: /\b[a-z]:[/\\]+users[/\\]+(?![<{$])[^/\\<>{}\s"'`,;:)\]]+/i,
  },
  {
    rule: 'absolute-home-posix',
    re: /(?:^|[\s"'`(=])\/(?:home|Users)\/+(?![<{$])[^/<>{}\s"'`,;:)\]]+/,
  },
];

const PROJECT_RE = new RegExp(PROJECT_WORDS.join('|'), 'i');

/**
 * Paths that may legitimately carry these strings.
 *
 * Kept as small as possible. Every entry is a hole in the check, so each one
 * names why it exists.
 */
const EXEMPT: Array<{ prefix: string; why: string }> = [
  // Lock files record the registry's own resolved paths and are generated.
  { prefix: 'package-lock.json', why: 'generated dependency lock' },
  // Vendored reference tables, whose provenance is tracked separately in
  // VENDORED.md. They carry illustrative paths in documentation examples,
  // which look identical to a real leak and break nothing when cloned. This is
  // the one place the check trades precision for not rewriting other people's
  // reference data.
  {
    prefix: 'doctrine/skills/ui-ux-pro-max/data/',
    why: 'vendored reference tables with illustrative paths',
  },
  // Static design-spec mockups (#89) that render the console UI with invented sample
  // data -- a fictional teammate roster and integration names -- to show what a real
  // board looks like. The same illustrative-content trade the ui-ux-pro-max entry above
  // already makes, for the same reason: rewriting the mockup's sample data to be
  // generic would make it a worse design reference for no gain in what actually ships.
  {
    prefix: 'doctrine/design/',
    why: 'static design mockups with invented illustrative sample data, never live config',
  },
];

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf', '.zip', '.gz',
  '.woff', '.woff2', '.ttf', '.eot', '.node', '.wasm', '.exe', '.dll',
]);

export function isExempt(file: string): boolean {
  const normalized = file.split(path.sep).join('/');
  return EXEMPT.some((entry) => normalized.startsWith(entry.prefix));
}

/** Scan one file's contents. Pure, so tests can feed it text directly. */
export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (PROJECT_RE.test(line)) {
      findings.push({
        file,
        line: index + 1,
        rule: 'project-specific-name',
        text: line.trim().slice(0, 160),
      });
    }
    for (const { rule, re } of PATH_RULES) {
      if (re.test(line)) {
        findings.push({ file, line: index + 1, rule, text: line.trim().slice(0, 160) });
      }
    }
  });
  return findings;
}

export function scanFiles(root: string, files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (isExempt(file)) continue;
    if (BINARY_EXT.has(path.extname(file).toLowerCase())) continue;
    const full = path.isAbsolute(file) ? file : path.join(root, file);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const text = readFileSync(full, 'utf8');
    findings.push(...scanText(file, text));
  }
  return findings;
}

export function trackedFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean);
}

export function runCheck(root: string): Finding[] {
  return scanFiles(root, trackedFiles(root));
}

function main(): void {
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const findings = runCheck(root);
  if (findings.length === 0) {
    const count = trackedFiles(root).length;
    console.log(`agnostic check: clean (${count} tracked files scanned)`);
    return;
  }
  console.error(`agnostic check: ${findings.length} finding(s)\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.text}`);
  }
  console.error('\nThis repository must stay project agnostic and machine agnostic.');
  console.error('Move the content to an overlay, or parameterise the path.');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

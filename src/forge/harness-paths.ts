/**
 * Whether a worker's tool call reaches the machine's own guards or an account's settings.
 *
 * 2026-09-14: the BBZ-307 worker had its pull request body refused by the readability guard
 * and spent eleven minutes reading `~/.claude/hooks/authorship_guard.py`, running it with test
 * bodies and writing a repro file into that folder. The guard was not changed, but a worker
 * debugging the guard that refused it is outside every brief and one edit away from changing
 * a guard that runs for every session on the machine.
 *
 * Two roots are protected: `<home>/.claude` and `<home>/.forge/accounts/configs` (every
 * account's config dir). A path is compared after the forms a Windows machine accepts for it
 * are folded together: `~`, `$HOME`, `${HOME}`, `$USERPROFILE`, `%USERPROFILE%`,
 * `$CLAUDE_CONFIG_DIR`, git-bash `/c/...`, backslashes, letter case, and `..` resolved
 * against the call's working directory and clamped at the drive root the way Windows does.
 *
 * Not caught, by design of a text check: a path built at runtime from pieces (`'~/.cl' +
 * 'aude'`), an encoded one, or a link from somewhere else that points into a root.
 */
import { homedir } from 'node:os';
import { posix } from 'node:path';

/** What a worker reads back when a call reaches either root. */
export const HARNESS_REFUSAL = 'Refused: a worker run never reads, runs or writes the machine\'s guards or account '
  + 'settings (~/.claude and ~/.forge/accounts/configs). If a guard refused your text or command, its reason '
  + 'already says what to change: rewrite the text or command to satisfy that reason instead of opening the guard.';

const FILE_KEYS = ['file_path', 'path', 'notebook_path'] as const;
/** A shell command's top-level segments, each run in the directory the last `cd` left. */
const SEGMENT = /&&|\|\||[;|\n]/;
/** What separates one word of a shell segment from the next, quotes and redirects included. */
const WORD = /[\s"'`()<>=,{}[\]]+/;
const GLOB_CHAR = /[*?[{]/;

function expandVariables(text: string, home: string): string {
  const account = `${home}/.forge/accounts/configs/current`;
  return text
    .replace(/%HOMEDRIVE%%HOMEPATH%/gi, () => home)
    .replace(/%(USERPROFILE|HOME)%/gi, () => home)
    .replace(/%CLAUDE_CONFIG_DIR%/gi, () => account)
    .replace(/\$\{(HOME|USERPROFILE)\}|\$(HOME|USERPROFILE)\b/g, () => home)
    .replace(/\$\{CLAUDE_CONFIG_DIR\}|\$CLAUDE_CONFIG_DIR\b/g, () => account);
}

/** `.` and `..` resolved, with `..` stopping at a drive's root the way Windows stops it. */
function resolveDots(path: string): string {
  const drive = /^([a-z]:)(\/.*)?$/i.exec(path);
  if (drive) return `${drive[1]}${posix.normalize(drive[2] ?? '/')}`;
  return posix.normalize(path);
}

function isAbsolute(path: string): boolean {
  return /^[a-z]:(\/|$)/i.test(path) || path.startsWith('/');
}

/** One comparable form of a path: forward slashes, drive-letter form, dots resolved, lower case. */
export function normalizePath(raw: string, cwd: string, home: string): string {
  let path = expandVariables(raw.trim(), home);
  if (path === '~' || /^~[\\/]/.test(path)) path = home + path.slice(1);
  path = path.replace(/\\/g, '/').replace(/^\/([a-z])(?=\/|$)/i, '$1:');
  if (!isAbsolute(path)) path = `${normalizePath(cwd, '/', home)}/${path}`;
  return resolveDots(path).replace(/(.)\/+$/, '$1').toLowerCase();
}

export function protectedRoots(home: string): string[] {
  const normalHome = normalizePath(home, '/', home);
  return [`${normalHome}/.claude`, `${normalHome}/.forge/accounts/configs`];
}

function under(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/** A search rooted above a protected root walks into it: `grep -r x ~`, `Glob('**', 'C:/Users')`. */
function above(path: string, roots: string[]): boolean {
  const withSlash = path.endsWith('/') ? path : `${path}/`;
  return roots.some((root) => root.startsWith(withSlash));
}

function looksLikePath(word: string): boolean {
  return word.includes('/') || word.includes('\\') || word.startsWith('~') || word.startsWith('.')
    || /^[a-z]:$/i.test(word);
}

// The literal part of a glob before its first wildcard segment: `<home>/**/x.py` gives `<home>`.
function globBase(pattern: string): string {
  const segments = pattern.replace(/\\/g, '/').split('/');
  const index = segments.findIndex((segment) => GLOB_CHAR.test(segment));
  return index === -1 ? pattern : segments.slice(0, index).join('/') || '.';
}

function shellHit(command: string, cwd: string, home: string, roots: string[]): string | undefined {
  let dir = cwd;
  for (const segment of expandVariables(command, home).split(SEGMENT)) {
    const words = segment.split(WORD).filter(Boolean);
    for (const word of words) {
      if (!looksLikePath(word)) continue;
      const path = normalizePath(word, dir, home);
      if (under(path, roots) || above(path, roots)) return path;
    }
    if (words[0] === 'cd' || words[0] === 'pushd') {
      dir = words[1] && words[1] !== '-' ? normalizePath(words[1], dir, home) : normalizePath(home, '/', home);
    }
  }
  return undefined;
}

/**
 * The protected path a tool call reaches, or `undefined` when it stays clear of both roots.
 * `cwd` is the run's working directory, which a relative path resolves against.
 */
export function harnessPathTouched(
  toolName: string, input: Record<string, unknown>, cwd: string, home: string = homedir(),
): string | undefined {
  const roots = protectedRoots(home);
  if (typeof input['command'] === 'string') {
    const hit = shellHit(input['command'], cwd, home, roots);
    if (hit) return hit;
  }
  const isSearch = toolName === 'Grep' || toolName === 'Glob';
  for (const key of FILE_KEYS) {
    const value = input[key];
    if (typeof value !== 'string' || !value.length) continue;
    const path = normalizePath(value, cwd, home);
    if (under(path, roots) || (isSearch && above(path, roots))) return path;
  }
  if (toolName === 'Glob' && typeof input['pattern'] === 'string') {
    const base = typeof input['path'] === 'string' && input['path'] ? input['path'] : cwd;
    const pattern = input['pattern'];
    const path = normalizePath(pattern, base, home);
    const patternBase = normalizePath(globBase(pattern), base, home);
    if (under(path, roots) || under(patternBase, roots) || above(patternBase, roots)) return patternBase;
  }
  return undefined;
}

/**
 * Whether a worker's tool call reaches the machine's own guards or an account's settings.
 *
 * 2026-09-14: the BBZ-307 worker had its pull request body refused by the readability guard
 * and spent eleven minutes reading `~/.claude/hooks/authorship_guard.py`, running it with test
 * bodies and writing a repro file into that folder. The guard was not changed, but a worker
 * debugging the guard that refused it is outside every brief and one edit away from changing
 * a guard that runs for every session on the machine.
 *
 * Protected: `<home>/.claude`, `<home>/.claude-fleet` (the fleet's config, whose settings wire
 * every guard), `<home>/.forge/accounts/configs` (every account's config dir) and a
 * `FORGE_CONFIG_DIR` override.
 *
 * A file tool's location is compared after the forms a Windows machine accepts for it are
 * folded together: `~`, `~user`, `$HOME`, `${HOME:-x}`, `$env:X`, `${env:X}`, `%X%`,
 * `$HOMEDRIVE$HOMEPATH`, `$USERNAME`, `$APPDATA`, `$CLAUDE_CONFIG_DIR`, `$FORGE_CONFIG_DIR`, the
 * `file://` and `@` prefixes, the `\\?\`, `\\.\`, admin-share, `/c/`, `//c/` and `/mnt/c/`
 * prefixes, backslashes, letter case, and `..` clamped at the drive root. An 8.3 short name
 * directly under home (`CLAUDE~1`) counts as protected, since the text cannot say which folder
 * it names.
 *
 * A shell command fails closed. It is refused when its text names a protected folder anywhere,
 * quoted, in a heredoc, in a substitution or in prose; when any word resolves into one; when it
 * changes directory to home or above; or when it walks recursively from there. Three review
 * rounds of skipping "prose" in a shell parser opened a hole per skip, so nothing is skipped:
 * text that has to name a protected folder goes in a file, passed by name.
 *
 * Read-only file tools may reach two places under a root: `skills/`, and
 * `projects/<slug>/<session>/tool-results/`, where Claude Code saves an oversized tool result.
 *
 * Not caught, by design of a text check: a path built at runtime from pieces (`'~/.cl' +
 * 'aude'`), an encoded one, or a link from outside that points into a root.
 */
import { homedir } from 'node:os';
import { posix } from 'node:path';

/** What a worker reads back when a call reaches a protected root. */
export const HARNESS_REFUSAL = 'Refused: a worker run never reads, runs or writes the machine\'s guards or account '
  + 'settings (~/.claude, ~/.claude-fleet and ~/.forge/accounts/configs), and a shell command may not name them. '
  + 'If a guard refused your text or command, its reason already says what to change: rewrite the text or command '
  + 'to satisfy that reason instead of opening the guard. If your text only mentions such a path, write it to a '
  + 'file in your worktree with the Write tool and pass the file (git commit -F, gh pr create --body-file), or '
  + 'search for it with the Grep tool.';

/** Input keys that name a location, for any tool: `file_path`, `path`, `notebook_path`, `filePath`, `paths`... */
const LOCATION_KEY = /path|file|dir|cwd|root/i;
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LSP', 'NotebookRead']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const GLOB_CHAR = /[*?[{]/;
/** What separates one word of shell text from the next, quotes, substitutions and redirects included. */
const WORD_BREAK = /[\s"'`()<>=,;|&{}!]+/;
const CD_WORDS = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location']);
/** Programs that walk every folder under the place they are given. */
const ALWAYS_WALKS = new Set([
  'rg', 'find', 'fd', 'tree', 'du', 'robocopy', 'xcopy', 'tar', 'zip', '7z', 'get-childitem', 'gci',
  'select-string', 'sls', 'ag', 'ack', 'findstr',
]);
/** Programs that walk only with a recursive flag, and the flag that makes them. */
const RECURSIVE_FLAGS: Record<string, RegExp> = {
  grep: /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)$/,
  ls: /^(-[a-zA-Z]*R[a-zA-Z]*|--recursive)$/,
  dir: /^\/s$/i,
  cp: /^(-[a-zA-Z]*[rRa][a-zA-Z]*|--recursive|--archive)$/,
  rsync: /^(-[a-zA-Z]*[rRa][a-zA-Z]*|--recursive|--archive)$/,
  scp: /^-[a-zA-Z]*r[a-zA-Z]*$/,
  rm: /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/,
  'copy-item': /^-recurse$/i,
  'remove-item': /^-recurse$/i,
};

function parentOf(path: string): string {
  return path.replace(/\/[^/]*$/, '') || path;
}

function lastSegment(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The variables that name home or a root, longest names first so `LOCALAPPDATA` wins over `APPDATA`. */
function variables(home: string): [string, string][] {
  return [
    ['LOCALAPPDATA', `${home}/AppData/Local`],
    ['APPDATA', `${home}/AppData/Roaming`],
    ['USERPROFILE', home],
    ['CLAUDE_CONFIG_DIR', `${home}/.claude`],
    ['FORGE_CONFIG_DIR', process.env['FORGE_CONFIG_DIR'] || `${home}/.claude-fleet`],
    ['USERNAME', lastSegment(home)],
    ['HOME', home],
  ];
}

function expandVariables(text: string, home: string): string {
  let out = text.replace(/%HOMEDRIVE%%HOMEPATH%|\$\{?(env:)?HOMEDRIVE\}?\$\{?(env:)?HOMEPATH\}?/gi, () => home);
  for (const [name, value] of variables(home)) {
    const pattern = new RegExp(`%${name}%|\\$\\{(env:)?${name}(:?[-=+?][^}]*)?\\}|\\$(env:)?${name}\\b`, 'gi');
    out = out.replace(pattern, () => value);
  }
  return out;
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

/** Device, admin-share, URL, git-bash and WSL prefixes folded to a drive letter. */
function foldPrefix(path: string): string {
  return path
    .replace(/^\/\/[?.]\/(unc\/)?/i, (_match, unc: string | undefined) => (unc ? '//' : ''))
    .replace(/^\/\/(localhost|127\.0\.0\.1|\.)\/([a-z])\$(?=\/|$)/i, '$2:')
    .replace(/^\/mnt\/([a-z])(?=\/|$)/i, '$1:')
    .replace(/^\/\/([a-z])(?=\/|$)/i, '$1:')
    .replace(/^\/([a-z]:)/i, '$1')
    .replace(/^\/([a-z])(?=\/|$)/i, '$1:');
}

/** One comparable form of a path: forward slashes, drive-letter form, dots resolved, lower case. */
export function normalizePath(raw: string, cwd: string, home: string): string {
  let path = expandVariables(raw.trim(), home).replace(/^@/, '').replace(/^file:(\/\/)?/i, '');
  if (path === '~' || /^~[\\/]/.test(path)) path = home + path.slice(1);
  else if (/^~[\w.-]+([\\/]|$)/.test(path)) path = `${parentOf(home.replace(/\\/g, '/'))}/${path.slice(1)}`;
  path = foldPrefix(path.replace(/\\/g, '/'));
  if (!isAbsolute(path)) path = `${normalizePath(cwd, '/', home)}/${path}`;
  return resolveDots(path).replace(/(.)\/+$/, '$1').toLowerCase();
}

export function protectedRoots(home: string): string[] {
  const normalHome = normalizePath(home, '/', home);
  const roots = [`${normalHome}/.claude`, `${normalHome}/.claude-fleet`, `${normalHome}/.forge/accounts/configs`];
  const override = process.env['FORGE_CONFIG_DIR'];
  if (override) roots.push(normalizePath(override, '/', home));
  return roots;
}

function rootHolding(path: string, roots: string[]): string | undefined {
  return roots.find((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * An 8.3 short name that could be a root: any short name directly under home (`CLAUDE~1`), or a
 * short-named home followed by a root or another short name. A short-named home followed by
 * anything else (`JOHNSM~1/AppData/Local/Temp`) is the temp folder Windows reports, and passes.
 */
function shortNameNearHome(path: string, home: string): boolean {
  const normalHome = normalizePath(home, '/', home);
  const parent = parentOf(normalHome);
  const segments = path.split('/');
  return segments.some((segment, index) => {
    if (index === 0 || !/~\d+$/.test(segment)) return false;
    const prefix = segments.slice(0, index).join('/');
    if (prefix === normalHome) return true;
    if (prefix !== parent) return false;
    const next = segments[index + 1] ?? '';
    return next === '.claude' || next === '.claude-fleet' || next === '.forge' || /~\d+$/.test(next);
  });
}

function reaches(path: string, roots: string[], home: string): boolean {
  return rootHolding(path, roots) !== undefined || shortNameNearHome(path, home);
}

/** A place above a protected root: walking it walks into the root. */
function above(path: string, roots: string[]): boolean {
  const withSlash = path.endsWith('/') ? path : `${path}/`;
  return roots.some((root) => root.startsWith(withSlash));
}

/** The two places under a root a read-only file tool may reach. */
function readableUnderRoot(path: string, roots: string[]): boolean {
  const root = rootHolding(path, roots);
  if (!root || path === root) return false;
  let rest = path.slice(root.length + 1);
  if (root.endsWith('/accounts/configs')) rest = rest.replace(/^[^/]+\/?/, '');
  return /^skills\//.test(rest) || /^projects\/[^/]+\/[^/]+\/tool-results\//.test(rest);
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

/** Every alternative a brace glob names, capped so a pathological pattern cannot run long. */
function expandBraces(pattern: string, limit = 64): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const out: string[] = [];
  for (const option of match[1]!.split(',')) {
    const next = pattern.slice(0, match.index) + option + pattern.slice(match.index + match[0].length);
    for (const expanded of expandBraces(next, limit)) {
      out.push(expanded);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function programName(word: string): string {
  return lastSegment(word).toLowerCase().replace(/\.exe$/, '');
}

/** Whether the text of a command names a root anywhere, whatever quotes or heredocs surround it. */
function textNamesRoot(command: string, home: string, roots: string[]): string | undefined {
  const text = expandVariables(command, home)
    .replace(/(^|[\s"'`(=:,;|&!@])~(?=[\\/]|$|[\s"'`)])/g, (_match, lead: string) => `${lead}${home}`)
    .replace(/\\ /g, ' ')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
  for (const root of roots) {
    const needle = root.replace(/^[a-z]:/, '');
    if (new RegExp(`${escapeRegExp(needle)}(?=$|[^\\w.-])`).test(text)) return root;
  }
  const normalHome = normalizePath(home, '/', home).replace(/^[a-z]:/, '');
  const shortUnderHome = new RegExp(`${escapeRegExp(normalHome)}/[^/\\s"'\`]*~\\d`);
  const shortHome = new RegExp(`${escapeRegExp(parentOf(normalHome))}/[^/\\s"'\`]*~\\d/(\\.claude|\\.forge/|[^/\\s"'\`]*~\\d)`);
  if (shortUnderHome.test(text) || shortHome.test(text)) return normalizePath(home, '/', home);
  return undefined;
}

function shellHit(command: string, cwd: string, home: string, roots: string[]): string | undefined {
  // Segments first, so a bare `cd` stays bare (`cd; cat x` goes home, never to a folder named `cat`).
  // Splitting ignores quotes on purpose: `bash -c "cd ~ && cat x"` changes directory too.
  const segments = expandVariables(command, home).replace(/\\ /g, ' ').split(/[;|&\n]+/)
    .map((segment) => segment.split(WORD_BREAK).filter(Boolean));
  const words = segments.flat();
  const dirs = [cwd];
  let walks = false;
  for (const segment of segments) {
    for (let index = 0; index < segment.length; index += 1) {
      const name = programName(segment[index]!);
      if (ALWAYS_WALKS.has(name)) walks = true;
      const flag = RECURSIVE_FLAGS[name];
      if (flag && segment.slice(index + 1).some((later) => flag.test(later))) walks = true;
      if (!CD_WORDS.has(name)) continue;
      const target = segment.slice(index + 1).find((later) => !later.startsWith('-') && !/^\/[a-z]$/i.test(later));
      const next = target
        ? normalizePath(target, dirs[dirs.length - 1]!, home)
        : normalizePath(home, '/', home);
      if (reaches(next, roots, home) || above(next, roots)) return next;
      dirs.push(next);
    }
  }
  for (const word of words) {
    if (!looksLikePath(word)) continue;
    for (const dir of dirs) {
      const path = normalizePath(word, dir, home);
      if (reaches(path, roots, home)) return path;
      if (walks && above(path, roots)) return path;
    }
  }
  return textNamesRoot(command, home, roots);
}

/** Every string a location-named key holds, arrays and nested objects included. */
function locations(input: Record<string, unknown>): string[] {
  const found: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === 'string') {
      if (value.length) found.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(collect);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(collect);
    }
  };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'command' || key === 'pattern' || !LOCATION_KEY.test(key)) continue;
    collect(value);
  }
  return found;
}

/**
 * The protected path a tool call reaches, or `undefined` when it stays clear of every root.
 * `cwd` is the run's working directory, which a relative path resolves against.
 */
export function harnessPathTouched(
  toolName: string, input: Record<string, unknown>, cwd: string, home: string = homedir(),
): string | undefined {
  const roots = protectedRoots(home);
  const readOnly = READ_ONLY_TOOLS.has(toolName);
  const isSearch = SEARCH_TOOLS.has(toolName);
  const blocked = (path: string) => reaches(path, roots, home) && !(readOnly && readableUnderRoot(path, roots));
  if (typeof input['command'] === 'string') {
    const hit = shellHit(input['command'], cwd, home, roots);
    if (hit) return hit;
  }
  for (const value of locations(input)) {
    const path = normalizePath(value, cwd, home);
    if (blocked(path) || (isSearch && above(path, roots))) return path;
  }
  if (toolName === 'Glob' && typeof input['pattern'] === 'string') {
    const base = typeof input['path'] === 'string' && input['path'] ? input['path'] : cwd;
    for (const alternative of expandBraces(input['pattern'])) {
      const path = normalizePath(alternative, base, home);
      const patternBase = normalizePath(globBase(alternative), base, home);
      if (blocked(path) || blocked(patternBase) || above(patternBase, roots)) return patternBase;
    }
  }
  return undefined;
}

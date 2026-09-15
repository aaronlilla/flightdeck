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
 * `FORGE_CONFIG_DIR` override. A path is compared after the forms a Windows machine accepts for
 * it are folded together: `~`, `~user`, `$HOME`, `${HOME:-x}`, `$env:USERPROFILE`,
 * `%USERPROFILE%`, `$HOMEDRIVE$HOMEPATH`, `$USERNAME`, `$APPDATA`, `$CLAUDE_CONFIG_DIR`, the
 * `\\?\`, `\\.\`, admin-share, git-bash `/c/` and `//c/` and WSL `/mnt/c/` prefixes,
 * backslashes, letter case, and `..` resolved against the working directory and clamped at the
 * drive root the way Windows clamps it. An 8.3 short name directly under home (`CLAUDE~1`) is
 * treated as protected, since which folder it names cannot be told from the text.
 *
 * Read-only calls may reach two places under a root: `skills/`, and a session's own
 * `projects/<slug>/<session>/tool-results/`, where Claude Code saves an oversized tool result
 * and tells the model to Read it. An account config dir reaches both through junctions.
 *
 * In a shell command, prose is not a path: a commit message, a PR body, an `echo`, a search
 * pattern, or a heredoc that does not feed an interpreter is skipped, while a redirect target
 * is always checked. Not caught, by design of a text check: a path built at runtime from pieces
 * (`'~/.cl' + 'aude'`), an encoded one, or a link from outside that points into a root.
 */
import { homedir } from 'node:os';
import { posix } from 'node:path';

/** What a worker reads back when a call reaches a protected root. */
export const HARNESS_REFUSAL = 'Refused: a worker run never reads, runs or writes the machine\'s guards or account '
  + 'settings (~/.claude, ~/.claude-fleet and ~/.forge/accounts/configs). If a guard refused your text or command, '
  + 'its reason already says what to change: rewrite the text or command to satisfy that reason instead of '
  + 'opening the guard.';

/** Input keys that name a location, for any tool: `file_path`, `path`, `notebook_path`, `filePath`, `cwd`... */
const LOCATION_KEY = /path|file|dir|cwd|root/i;
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LSP', 'NotebookRead']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const GLOB_CHAR = /[*?[{]/;

const INTERPRETERS = new Set([
  'python', 'python3', 'py', 'node', 'deno', 'bun', 'bash', 'sh', 'zsh', 'pwsh', 'powershell', 'ruby', 'perl',
  'php', 'cmd', 'tsx', 'npx',
]);
/** Programs whose words are printed, never opened: only a redirect target is a path. */
const PRINTERS = new Set(['echo', 'printf', 'write-output', 'write-host']);
/** Programs whose quoted multi-word arguments are prose (a message, a title, a body). */
const PROSE_PROGRAMS = new Set(['git', 'gh', 'jira', 'curl']);
/** Search programs: the first positional argument is a pattern, the rest are places to search. */
const SEARCHERS = new Set(['rg', 'grep', 'ag', 'ack', 'select-string', 'sls', 'findstr']);
const SEARCH_VALUE_FLAGS = new Set([
  '-e', '--regexp', '-f', '--file', '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '-A', '-B', '-C',
  '--after-context', '--before-context', '--context', '-m', '--max-count', '--include', '--exclude',
  '--exclude-dir', '-M', '--max-columns', '-j', '--threads', '--color', '--colors', '-E', '--encoding',
]);
/** Programs that walk every folder under the place they are given. */
const ALWAYS_WALKS = new Set([
  'rg', 'find', 'fd', 'tree', 'du', 'robocopy', 'xcopy', 'tar', 'zip', '7z', 'get-childitem', 'gci',
  'select-string', 'sls', 'ag', 'ack',
]);
const WALKS_WITH_FLAG = new Set(['grep', 'ls', 'dir', 'cp', 'copy-item', 'rm', 'remove-item', 'findstr']);
const RECURSIVE_FLAG = /^(-[a-z]*[rR][a-z]*|--recursive|-recurse|\/s)$/i;
const CD_PROGRAMS = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl']);
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nice', 'command', 'exec', 'wsl', 'start']);

interface Word { text: string; quoted: boolean; redirect: boolean }

function parentOf(path: string): string {
  return path.replace(/\/[^/]*$/, '') || path;
}

function lastSegment(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}

function expandVariables(text: string, home: string): string {
  const account = `${home}/.claude`;
  const user = lastSegment(home);
  const roaming = `${home}/AppData/Roaming`;
  const local = `${home}/AppData/Local`;
  return text
    .replace(/%HOMEDRIVE%%HOMEPATH%|\$\{?(env:)?HOMEDRIVE\}?\$\{?(env:)?HOMEPATH\}?/gi, () => home)
    .replace(/%(USERPROFILE|HOME)%/gi, () => home)
    .replace(/%CLAUDE_CONFIG_DIR%/gi, () => account)
    .replace(/%USERNAME%/gi, () => user)
    .replace(/%LOCALAPPDATA%/gi, () => local)
    .replace(/%APPDATA%/gi, () => roaming)
    .replace(/\$\{(HOME|USERPROFILE)(:?[-=+?][^}]*)?\}/gi, () => home)
    .replace(/\$\{CLAUDE_CONFIG_DIR(:?[-=+?][^}]*)?\}/gi, () => account)
    .replace(/\$\{USERNAME(:?[-=+?][^}]*)?\}/gi, () => user)
    .replace(/\$\{LOCALAPPDATA(:?[-=+?][^}]*)?\}/gi, () => local)
    .replace(/\$\{APPDATA(:?[-=+?][^}]*)?\}/gi, () => roaming)
    .replace(/\$(env:)?(HOME|USERPROFILE)\b/gi, () => home)
    .replace(/\$(env:)?CLAUDE_CONFIG_DIR\b/gi, () => account)
    .replace(/\$(env:)?USERNAME\b/gi, () => user)
    .replace(/\$(env:)?LOCALAPPDATA\b/gi, () => local)
    .replace(/\$(env:)?APPDATA\b/gi, () => roaming);
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

/** Device, admin-share, git-bash and WSL prefixes folded to a drive letter. */
function foldPrefix(path: string): string {
  return path
    .replace(/^\/\/[?.]\/(unc\/)?/i, (_match, unc: string | undefined) => (unc ? '//' : ''))
    .replace(/^\/\/(localhost|127\.0\.0\.1|\.)\/([a-z])\$(?=\/|$)/i, '$2:')
    .replace(/^\/mnt\/([a-z])(?=\/|$)/i, '$1:')
    .replace(/^\/\/([a-z])(?=\/|$)/i, '$1:')
    .replace(/^\/([a-z])(?=\/|$)/i, '$1:');
}

/** One comparable form of a path: forward slashes, drive-letter form, dots resolved, lower case. */
export function normalizePath(raw: string, cwd: string, home: string): string {
  let path = expandVariables(raw.trim(), home);
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

/** An 8.3 short name sitting directly under home or its parent: `CLAUDE~1`, `FORGE~1`, `AARONL~1`. */
function shortNameNearHome(path: string, home: string): boolean {
  const normalHome = normalizePath(home, '/', home);
  const segments = path.split('/');
  return segments.some((segment, index) => {
    if (index === 0 || !/~\d+$/.test(segment)) return false;
    const prefix = segments.slice(0, index).join('/');
    return prefix === normalHome || prefix === parentOf(normalHome);
  });
}

function reaches(path: string, roots: string[], home: string): boolean {
  return rootHolding(path, roots) !== undefined || shortNameNearHome(path, home);
}

/** A search rooted above a protected root walks into it: `grep -r x ~`, `Glob('**', <home>)`. */
function above(path: string, roots: string[]): boolean {
  const withSlash = path.endsWith('/') ? path : `${path}/`;
  return roots.some((root) => root.startsWith(withSlash));
}

/** The two places under a root a read-only call may reach. */
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

/**
 * A shell command's words, each marked quoted or not and whether it follows a redirect. Heredoc
 * bodies are removed unless `keepBody` says the command feeding them is an interpreter.
 */
function splitHeredocs(command: string): { shell: string; bodies: { program: string; body: string }[] } {
  const lines = command.split('\n');
  const shell: string[] = [];
  const bodies: { program: string; body: string }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    shell.push(line);
    const marker = /<<-?\s*(['"]?)([\w.-]+)\1/.exec(line);
    if (!marker) continue;
    const body: string[] = [];
    index += 1;
    while (index < lines.length && lines[index]!.trim() !== marker[2]) {
      body.push(lines[index]!);
      index += 1;
    }
    const before = line.slice(0, marker.index).split(/&&|\|\||[;|]/).pop() ?? '';
    bodies.push({ program: programOf(tokenize(before)), body: body.join('\n') });
  }
  return { shell: shell.join('\n'), bodies };
}

function tokenize(text: string): Word[] {
  const words: Word[] = [];
  let current = '';
  let quote: string | null = null;
  let quoted = false;
  let redirectNext = false;
  const flush = () => {
    if (current) words.push({ text: current, quoted, redirect: redirectNext });
    if (current) redirectNext = false;
    current = '';
    quoted = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      quoted = true;
      continue;
    }
    if (char === '>') {
      flush();
      redirectNext = true;
      continue;
    }
    if (/[\s<()=,]/.test(char)) {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return words;
}

function programName(word: string): string {
  return lastSegment(word).toLowerCase().replace(/\.exe$/, '');
}

/** The program a segment runs: its first word that is not a wrapper like `sudo`, `env` or `wsl`. */
function programOf(words: Word[]): string {
  for (const word of words) {
    const name = programName(word.text);
    if (!WRAPPERS.has(name)) return name;
  }
  return '';
}

/** A shell command's top-level segments, split on `;`, `|`, `&&`, `||` and newlines outside quotes. */
function splitSegments(text: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ';' || char === '|' || char === '\n' || (char === '&' && text[index + 1] === '&')) {
      segments.push(current);
      current = '';
      if (char === '&' || (char === '|' && text[index + 1] === '|')) index += 1;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

/** Sub-words of a quoted span that an interpreter would read as separate strings. */
function subWords(text: string): string[] {
  return text.split(/[\s"'`()<>=,;{}[\]]+/).filter(Boolean);
}

function shellHit(command: string, cwd: string, home: string, roots: string[]): string | undefined {
  const { shell, bodies } = splitHeredocs(expandVariables(command, home));
  let dir = cwd;
  const check = (raw: string, base: string): string | undefined => {
    if (!looksLikePath(raw)) return undefined;
    const path = normalizePath(raw, base, home);
    return reaches(path, roots, home) ? path : undefined;
  };
  for (const segment of splitSegments(shell)) {
    // An assignment (`D=~/x`) splits at `=`, so its value is a word of its own and still checked.
    const words = tokenize(segment);
    const program = programOf(words);
    const args = words.slice(Math.max(0, words.findIndex((word) => programName(word.text) === program)) + 1);
    const walks = ALWAYS_WALKS.has(program)
      || (WALKS_WITH_FLAG.has(program) && args.some((word) => RECURSIVE_FLAG.test(word.text)));
    let patternSeen = false;
    let skipValue = false;
    for (const word of words) {
      if (word.redirect) {
        const hit = check(word.text, dir);
        if (hit) return hit;
        continue;
      }
      if (programName(word.text) === program && !word.quoted) continue;
      if (PRINTERS.has(program)) continue;
      if (SEARCHERS.has(program)) {
        if (skipValue) {
          skipValue = false;
          continue;
        }
        if (SEARCH_VALUE_FLAGS.has(word.text)) {
          skipValue = true;
          continue;
        }
        if (!word.text.startsWith('-') && !patternSeen) {
          patternSeen = true;
          continue;
        }
      }
      if (word.quoted && PROSE_PROGRAMS.has(program) && /\s/.test(word.text)) continue;
      const pieces = word.quoted ? subWords(word.text) : [word.text];
      for (const piece of pieces) {
        const hit = check(piece, dir);
        if (hit) return hit;
        if (walks && looksLikePath(piece) && above(normalizePath(piece, dir, home), roots)) {
          return normalizePath(piece, dir, home);
        }
      }
    }
    if (CD_PROGRAMS.has(program)) {
      const target = args.find((word) => !word.text.startsWith('-'));
      if (target?.text === '-') continue;
      const next = target ? normalizePath(target.text, dir, home) : normalizePath(home, '/', home);
      if (reaches(next, roots, home) || above(next, roots)) return next;
      dir = next;
    }
  }
  for (const { program, body } of bodies) {
    if (!INTERPRETERS.has(program)) continue;
    for (const piece of subWords(body)) {
      const hit = check(piece, dir);
      if (hit) return hit;
    }
  }
  return undefined;
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
  for (const [key, value] of Object.entries(input)) {
    if (key === 'command' || key === 'pattern' || !LOCATION_KEY.test(key)) continue;
    if (typeof value !== 'string' || !value.length) continue;
    const path = normalizePath(value, cwd, home);
    if (blocked(path) || (isSearch && above(path, roots))) return path;
  }
  if (toolName === 'Glob' && typeof input['pattern'] === 'string') {
    const base = typeof input['path'] === 'string' && input['path'] ? input['path'] : cwd;
    const pattern = input['pattern'];
    for (const alternative of [pattern, ...pattern.split(/[{},]/)]) {
      if (!alternative) continue;
      const path = normalizePath(alternative, base, home);
      const patternBase = normalizePath(globBase(alternative), base, home);
      if (blocked(path) || blocked(patternBase) || above(patternBase, roots)) return patternBase;
    }
  }
  return undefined;
}

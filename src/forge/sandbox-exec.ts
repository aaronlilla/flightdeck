/**
 * Requirement: contain what a run executes.
 *
 * A git worktree separates working trees; it does not isolate anything. A verification
 * command runs arbitrary code from the repository under test -- test files, and every
 * `postinstall` script in its dependency tree -- as the operator's own user, with the
 * operator's network and the operator's whole filesystem in reach. `npm test` in a
 * worktree can read `~/.aws/credentials`, an SSH private key, or any `.env` on the box,
 * and post it anywhere. Linked worktrees also share the primary checkout's single `.git`
 * object store, so a `git gc --prune=now` inside one damages the primary and every
 * sibling at once.
 *
 * This module puts a real boundary around that command. It builds the argv for running a
 * command inside a container whose only mount is the worktree itself, with networking off
 * by default, as a non-root user, removed on exit. What it cannot reach, it cannot leak.
 *
 * The sandbox is opt-in (`FORGE_SANDBOX=1`), because a host with no container runtime
 * must keep working rather than silently failing every verification. `describeSandbox`
 * exists so a caller can say plainly, in the PR body and the journal, whether a given
 * verdict was proven inside the boundary or merely on the host -- an unproven claim of
 * containment would be worse than no containment at all.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SandboxConfig {
  /**
   * On by default. A boundary nobody turns on is not a boundary: the overwhelming
   * majority of runs take the default, so the default is the security posture. Set
   * `FORGE_SANDBOX=0` to opt out deliberately, which is recorded rather than assumed.
   */
  enabled: boolean;
  /**
   * True only when the operator explicitly set `FORGE_SANDBOX=0`. This is what tells a
   * missing container runtime (a machine that cannot contain, and must therefore refuse
   * to claim it verified anything) apart from a human who decided not to contain and
   * accepted that.
   */
  optedOut: boolean;
  /** `FORGE_SANDBOX_IMAGE`. The image a command runs in. */
  image: string;
  /**
   * `FORGE_SANDBOX_NETWORK`. `none` by default: a verification command that cannot
   * open a socket cannot exfiltrate what it reads. Set `bridge` only for a repository
   * whose tests genuinely need the network, and know that doing so reopens that door.
   */
  network: 'none' | 'bridge';
  /**
   * `FORGE_SANDBOX_USER`, default `1000:1000`. Running as a non-root uid means a
   * container escape lands as an unprivileged user rather than as root, and files the
   * command writes into the mounted worktree stay owned by a real account.
   */
  user: string;
  /** The container runtime binary. `FORGE_SANDBOX_RUNTIME`, default `docker`. */
  runtime: string;
  /**
   * Resource ceilings. Capabilities and the network are not the whole threat: a
   * malicious `postinstall` or a runaway test inside the boundary can fork-bomb or
   * allocate until the host OOMs, and the wall/idle budget would not notice for
   * fifteen minutes -- the host would be dead long before the reap ran. Time is not a
   * resource limit. `FORGE_SANDBOX_PIDS`, `_MEMORY`, `_CPUS`.
   */
  pids: string;
  memory: string;
  cpus: string;
}

export const DEFAULT_SANDBOX_IMAGE = 'node:22-bookworm-slim';

export function readSandboxConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const network = env['FORGE_SANDBOX_NETWORK'] === 'bridge' ? 'bridge' : 'none';
  const optedOut = env['FORGE_SANDBOX'] === '0';
  return {
    enabled: !optedOut,
    optedOut,
    image: env['FORGE_SANDBOX_IMAGE'] ?? DEFAULT_SANDBOX_IMAGE,
    network,
    pids: env['FORGE_SANDBOX_PIDS'] ?? '512',
    memory: env['FORGE_SANDBOX_MEMORY'] ?? '4g',
    cpus: env['FORGE_SANDBOX_CPUS'] ?? '2',
    user: env['FORGE_SANDBOX_USER'] ?? '1000:1000',
    runtime: env['FORGE_SANDBOX_RUNTIME'] ?? 'docker',
  };
}

/**
 * A host path as a container runtime wants it on the command line. A Windows path
 * (`C:\dev\x` or `C:/dev/x`) has to travel as `/c/dev/x`, or the bind mount silently
 * becomes a named volume and the command runs against an empty directory -- passing,
 * proving nothing, which is precisely the failure this whole module exists to prevent.
 */
export function mountPathFor(hostPath: string): string {
  const normalised = hostPath.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalised);
  if (!drive) return normalised;
  return `/${drive[1]!.toLowerCase()}/${drive[2]!}`;
}

/**
 * The primary checkout's object store, and which worktree inside it this run owns.
 *
 * Supplying this lets `git` run INSIDE the boundary. Without it, git has to be carved
 * out to the host -- and every escape this boundary has lost was reached through that
 * carve-out, because an allowlist over a programmable binary is only ever as current as
 * its last patch.
 *
 * The mount is deliberately not the default. It is shared with the primary checkout and
 * every sibling worktree, so a contained `git` can still damage refs the host depends
 * on; a caller has to decide that trade knowingly.
 */
export interface GitStoreMount {
  /**
   * Host path of the primary `.git` directory, e.g. `C:/dev/fd-sandbox/.git`.
   * Mounted READ-ONLY: it holds `hooks/` and `config`, and `hooks/` is the host
   * checkout's default hook directory, so a writable mount would let a contained
   * command plant a `pre-commit` the HOST then executes.
   */
  hostGitDir: string;
  /** The worktree's name under `.git/worktrees/`. */
  worktreeName: string;
  /**
   * Host path of this worktree's own GIT_DIR (`<primary>/.git/worktrees/<name>`),
   * mounted read-write. A run needs to move its own branch ref and record its own
   * index; it never needs to write the shared store.
   */
  hostWorktreeGitDir: string;
}

/**
 * Reads a worktree's `.git` pointer to find the object store it belongs to.
 *
 * A linked worktree's `.git` is a file, not a directory: `gitdir: <primary>/.git/
 * worktrees/<name>`. That one line names both halves of the mount, so nothing has to be
 * configured -- the boundary can work out for itself how to let `git` run inside.
 *
 * Returns undefined for a primary checkout (where `.git` is a directory) or anything it
 * cannot parse, so a caller falls back to whatever it did before rather than guessing.
 */
export function resolveGitStore(worktreePath: string): GitStoreMount | undefined {
  try {
    const pointer = join(worktreePath, '.git');
    if (!statSync(pointer).isFile()) return undefined;
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(pointer, 'utf8'));
    if (!match?.[1]) return undefined;
    const gitDir = match[1].replace(/\\/g, '/');
    const parts = /^(.*\/\.git)\/worktrees\/([^/]+)\/?$/.exec(gitDir);
    if (!parts?.[1] || !parts[2]) return undefined;
    return {
      hostGitDir: parts[1], worktreeName: parts[2], hostWorktreeGitDir: gitDir,
    };
  } catch {
    return undefined;
  }
}

export interface SandboxedCommand {
  argv: string[];
  /** True when the command is wrapped; false when it will run directly on the host. */
  contained: boolean;
  /**
   * The container's name, when one was started. A budget kill reaches the *runtime CLI*
   * process tree, but the container is a child of the daemon rather than of that CLI, so
   * killing the tree leaves the workload running past its wall/idle budget -- an escaped
   * run holding the worktree mount open forever. The caller reaps this name to close that
   * gap; see `sandboxReapCommand`.
   */
  containerName?: string;
}

/**
 * A container name unique to one command inside one run, so a reap can never target
 * another run's container. Docker names allow `[a-zA-Z0-9][a-zA-Z0-9_.-]*`, so anything
 * else in the run name is flattened.
 */
export function containerNameFor(runName: string, index: number): string {
  const safe = runName.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '');
  return `forge-${safe || 'run'}-${index}`;
}

/**
 * Wraps one command so it runs inside the boundary.
 *
 * The command travels as a single string to the container's own shell, because a verify
 * command routinely chains steps with `&&`; splitting it into an argv and letting the
 * runtime exec it directly would turn the operator into a literal argument.
 *
 * With the sandbox disabled this returns the command untouched and says so, so the caller
 * never has to guess whether containment actually happened.
 */
export function sandboxCommand(
  config: SandboxConfig,
  input: { command: string; cwd: string; name?: string; gitStore?: GitStoreMount },
): SandboxedCommand {
  if (!config.enabled) return { argv: [input.command], contained: false };

  const mount = mountPathFor(input.cwd);
  const containerName = input.name ?? containerNameFor('run', 0);
  // Reaching the object store is what lets `git` run inside the boundary instead of
  // being carved out to the host. Every escape this guard has lost was reached through
  // that carve-out, so closing it is worth a second mount.
  //
  // The shared store is read-only, and that is not a detail. `<primary>/.git` contains
  // `hooks/` and `config`, and `hooks/` is git's DEFAULT hook directory for the host
  // checkout -- so a writable mount would let a contained command drop
  // `hooks/pre-commit` and have the HOST execute it on its next commit. That is exactly
  // the core.hooksPath escape closed earlier, re-opened through the back door.
  //
  // Measured with a real git against a real linked worktree, not assumed:
  //   - new objects CAN be routed out of the read-only store, with a writable
  //     `GIT_OBJECT_DIRECTORY` and the shared store as `GIT_ALTERNATE_OBJECT_DIRECTORIES`
  //     (a commit then wrote 3 loose objects into the scratch dir and read its parents
  //     from the alternate);
  //   - a branch ref CANNOT. A linked worktree's `refs/heads/<branch>` lives in the
  //     SHARED store, not in `worktrees/<name>/`, so `git commit` writes there by
  //     construction. `worktrees/<name>/` holds only HEAD, index, logs and
  //     worktree-scoped refs.
  //
  // So a read-only shared store means a contained `git commit` fails on the ref write.
  // That is the honest state: reads (`status`, `log`, `diff`, `rev-parse`) are contained
  // and work; a contained commit does not. Making commits work without handing back
  // write access to `hooks/` needs ref writes proxied out of the container -- a design,
  // not a mount flag. Failing loudly beats granting the escape back.
  const gitArgs = input.gitStore
    ? [
      '-v', `${mountPathFor(input.gitStore.hostGitDir)}:/gitstore:ro`,
      // The run's own GIT_DIR, writable: HEAD, index and logs live here, so a read is
      // fully functional and a commit gets as far as the ref write before refusing.
      '-v', `${mountPathFor(input.gitStore.hostWorktreeGitDir)}:/gitdir`,
      // GIT_DIR rather than rewriting the worktree's `.git` file: the file names a
      // HOST path, and mutating it would corrupt the checkout for the host and every
      // sibling worktree the moment a container exits mid-command.
      '-e', 'GIT_DIR=/gitdir',
      // New objects are written to a container-local scratch dir; the shared store is
      // an alternate, so existing history resolves without being writable.
      '-e', 'GIT_OBJECT_DIRECTORY=/tmp/forge-objects',
      '-e', 'GIT_ALTERNATE_OBJECT_DIRECTORIES=/gitstore/objects',
      '-e', 'GIT_WORK_TREE=/work',
      // The mounted store is owned by the host user, not by uid 1000 inside.
      '-e', 'GIT_CONFIG_GLOBAL=/dev/null',
      '-e', 'GIT_CONFIG_SYSTEM=/dev/null',
      '-e', 'GIT_TERMINAL_PROMPT=0',
    ]
    : [];

  return {
    contained: true,
    containerName,
    argv: [
      config.runtime, 'run', '--rm',
      // Removed on exit: a crashed run leaves no container behind to be reused,
      // inspected, or to keep holding the mount open.
      '--name', containerName,
      // Named so a budget kill can reap the container itself. Killing the runtime CLI
      // does not stop the daemon's child; without this the workload outlives its budget.
      '--network', config.network,
      '--user', config.user,
      // The worktree is the ONLY host path the command can see. No home directory, no
      // credential file, no sibling checkout -- and the object store only when a caller
      // explicitly asks for it, because that mount is shared with the primary checkout.
      '-v', `${mount}:/work`,
      '-w', '/work',
      ...gitArgs,
      // A container that cannot gain privileges cannot use a setuid binary inside the
      // image to climb back out of the unprivileged user above.
      '--security-opt', 'no-new-privileges',
      // Time is not a resource limit. Without these, a fork bomb or a runaway
      // allocation inside the boundary takes the host down, and the 900s wall budget
      // would not notice for fifteen minutes.
      '--pids-limit', config.pids,
      '--memory', config.memory,
      '--memory-swap', config.memory,
      '--cpus', config.cpus,
      config.image,
      'sh', '-lc', input.command,
    ],
  };
}

/**
 * The command that forcibly removes a sandbox container, by name.
 *
 * Run unconditionally once a contained command settles, however it settled: a normal exit
 * has already removed it (`--rm`) and this is a harmless no-op, while a timeout or a
 * budget kill leaves a container the daemon is still happily running. Reaping by name is
 * what makes the wall/idle budget mean anything inside the boundary.
 *
 * This covers a command that ended. It does NOT cover a parent that died mid-command --
 * for that the caller needs a process-exit sweep; see `sandboxSweepCommand`.
 */
export function sandboxReapCommand(config: SandboxConfig, containerName: string): string[] {
  return [config.runtime, 'rm', '-f', containerName];
}

/** Every container this process may have started, for a shutdown sweep. */
export const SANDBOX_CONTAINER_PREFIX = 'forge-';

/**
 * Removes every sandbox container left behind, by prefix.
 *
 * The per-command reap runs in a `finally`, which never executes if the process itself
 * is killed -- a SIGINT during a verification leaves a container running with the
 * worktree mounted, indefinitely. A shutdown sweep is the only thing that closes that,
 * and it is why a stable name prefix exists.
 */
export function sandboxSweepCommand(config: SandboxConfig): string[] {
  return [
    config.runtime, 'rm', '-f',
    '$(' + config.runtime + ' ps -aq --filter name=^' + SANDBOX_CONTAINER_PREFIX + ')',
  ];
}

/** One line for a journal row or a PR body, saying exactly what did or did not contain a run. */
export function describeSandbox(config: SandboxConfig): string {
  if (!config.enabled) {
    return 'host (FORGE_SANDBOX=0; commands ran as the operator with full filesystem and network access)';
  }
  return `${config.runtime} ${config.image}, network=${config.network}, user=${config.user}, worktree mounted at /work`;
}

/**
 * Whether the container runtime is actually usable right now.
 *
 * Containment that silently degrades to the host is worse than no containment, because
 * the verdict still reads `done` and nothing in the record says the boundary was absent.
 * A run that expected to be contained and cannot be must refuse to claim it verified
 * anything -- the same rule the brief-supplied grader closed, applied to the boundary.
 */
export async function sandboxRuntimeReady(
  config: SandboxConfig,
  probe: (argv: string[]) => Promise<{ ok: boolean }>,
): Promise<boolean> {
  if (!config.enabled) return false;
  const result = await probe([config.runtime, 'version', '--format', '{{.Server.Version}}'])
    .catch(() => ({ ok: false }));
  return result.ok;
}

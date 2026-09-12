/**
 * Every environment variable the chain reads, parsed once and never read from
 * `process.env` anywhere else in `chain.ts`/`chain-wire.ts` -- the same split
 * `intake/repoRoute.ts` keeps for `FORGE_INTAKE_REPO_MAP`, so no repository name, site,
 * ticket key or path of this machine ever lands in a tracked file, only in whatever
 * launches `forge up`.
 */

export interface RepoScopedValue {
  repo: string;
  value: string;
}

/** `owner/name=value,owner2/name2=value2`, in order, first match wins on lookup. A
 *  value may itself contain `=` (a shell command carries plenty), so only the first `=`
 *  splits the entry. */
export function parseRepoScoped(raw: string | undefined): RepoScopedValue[] {
  if (!raw || raw.trim().length === 0) return [];
  return raw.split(',').map((entry) => {
    const trimmed = entry.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      throw new Error(`malformed entry "${trimmed}" (expected owner/name=value)`);
    }
    return { repo: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim() };
  });
}

export function lookupRepoScoped(entries: RepoScopedValue[], repo: string): string | undefined {
  return entries.find((entry) => entry.repo === repo)?.value;
}

export interface ChainEnv {
  enabled: boolean;
  pollSeconds: number;
  checkouts: RepoScopedValue[];
  bases: RepoScopedValue[];
  worktreeSetup: RepoScopedValue[];
  verify: RepoScopedValue[];
  mergeRepos: string[];
  forceCodex: boolean;
  /** A.4: `FORGE_REPO_KIND` (`owner/name=backend`, `owner/name=frontend`), the same
   *  `owner/name=value` shape every other repo-scoped setting here uses. A repo with no
   *  entry is `frontend` -- the terminal state every specimen before this stream already
   *  assumed. */
  repoKinds: RepoScopedValue[];
  /** C1: `FORGE_WORKTREE_SHELL`, split into a shell binary plus its flags (e.g. a bash
   *  path and `-c`). Empty when unset, which tells the launcher to fall back to the
   *  platform's own default shell (`shell: true`) rather than a named one. Not
   *  repository-scoped like the values above -- one shell serves every repository this
   *  worker provisions. */
  shell: string[];
}

const DEFAULT_POLL_SECONDS = 300;
const DEFAULT_BASE = 'develop';

function parseCommaList(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return [];
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

/** C1: `FORGE_WORKTREE_SHELL` is a shell binary plus its flags, whitespace separated
 *  (e.g. `/bin/bash -c`), never comma-separated like the lists above. */
export function parseShellPrefix(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return [];
  return raw.split(/\s+/).filter(Boolean);
}

export function readChainEnv(env: NodeJS.ProcessEnv = process.env): ChainEnv {
  const pollRaw = env['FORGE_CHAIN_POLL_S'];
  const pollSeconds = pollRaw ? Number(pollRaw) : DEFAULT_POLL_SECONDS;
  return {
    enabled: env['FORGE_CHAIN'] === '1',
    pollSeconds: Number.isFinite(pollSeconds) && pollSeconds > 0 ? pollSeconds : DEFAULT_POLL_SECONDS,
    checkouts: parseRepoScoped(env['FORGE_REPO_CHECKOUTS']),
    bases: parseRepoScoped(env['FORGE_REPO_BASE']),
    worktreeSetup: parseRepoScoped(env['FORGE_WORKTREE_SETUP']),
    verify: parseRepoScoped(env['FORGE_REPO_VERIFY']),
    mergeRepos: parseCommaList(env['FORGE_CHAIN_MERGE']),
    forceCodex: env['FORGE_COUNCIL_CODEX'] === 'always',
    shell: parseShellPrefix(env['FORGE_WORKTREE_SHELL']),
    repoKinds: parseRepoScoped(env['FORGE_REPO_KIND']),
  };
}

/** A.4: which side of `intake/handoff.ts#terminalStateFor` a repository is on. No entry
 *  in `FORGE_REPO_KIND` for it (including the common case of the variable being unset
 *  entirely) reads as `frontend`. */
export function repoKindFor(chainEnv: ChainEnv, repo: string): 'backend' | 'frontend' {
  return lookupRepoScoped(chainEnv.repoKinds, repo) === 'backend' ? 'backend' : 'frontend';
}

export function baseFor(chainEnv: ChainEnv, repo: string): string {
  return lookupRepoScoped(chainEnv.bases, repo) ?? DEFAULT_BASE;
}

export function checkoutFor(chainEnv: ChainEnv, repo: string): string | undefined {
  return lookupRepoScoped(chainEnv.checkouts, repo);
}

export function worktreeSetupFor(chainEnv: ChainEnv, repo: string): string | undefined {
  return lookupRepoScoped(chainEnv.worktreeSetup, repo);
}

export function verifyCommandFor(chainEnv: ChainEnv, repo: string): string | undefined {
  return lookupRepoScoped(chainEnv.verify, repo);
}

export function mergeAllowedFor(chainEnv: ChainEnv, repo: string): boolean {
  return chainEnv.mergeRepos.includes(repo);
}

/** A worktree lives beside its checkout, in a `worktrees` sibling directory, named
 *  `<name-lower>--<ticket-lower>` -- the same shape this workspace already uses for
 *  every other repository's worktrees. `checkout` is the local clone's own path
 *  (`FORGE_REPO_CHECKOUTS`'s value for this repo), never derived from the repository
 *  name alone. */
/** Item 12 (2026-09-11): the doc comment above assumed a checkout always sits one
 *  level under the workspace root, so the worktrees directory was always "the
 *  checkout's parent, plus `worktrees`". That breaks when the configured checkout is
 *  ITSELF a worktree -- its parent is already the worktrees directory, and appending
 *  `worktrees` again doubled the segment, landing new worker trees one level too deep,
 *  invisible to the coordination board and the cleanup, which scan the workspace's own
 *  worktrees directory and nothing below it. Seen live on a real ticket that day.
 *
 *  Fix: if the checkout's parent directory already ends in a `worktrees` segment, that
 *  IS the worktrees directory -- do not append a second one. A plain checkout (parent
 *  not named `worktrees`) still gets `<parent>/worktrees` exactly as before. This does
 *  not move any tree that already exists under the doubled path; a live worker's path
 *  there must keep resolving. */
export function worktreePathFor(checkout: string, repo: string, ticket: string): string {
  const sep = checkout.includes('\\') && !checkout.includes('/') ? '\\' : '/';
  const parent = checkout.replace(/[/\\]+$/, '');
  const lastSep = Math.max(parent.lastIndexOf('/'), parent.lastIndexOf('\\'));
  const parentDir = lastSep === -1 ? '' : parent.slice(0, lastSep);
  const name = repo.split('/').pop()!.toLowerCase();
  const worktreesDir = /(^|[/\\])worktrees$/i.test(parentDir) ? parentDir : `${parentDir}${sep}worktrees`;
  return `${worktreesDir}${sep}${name}--${ticket.toLowerCase()}`;
}

const HOTFIX_TICKET_PREFIX = 'hotfix-';

/** A.6: a hotfix's own minted ticket (`queue-wire.ts#queuePlanner().planHotfix`, prefix
 *  `hotfix-`) branches onto `hotfix/<slug>` instead of `feature/<ticket>` -- read off
 *  the ticket string itself rather than a `source` argument threaded through
 *  `ChainLauncher.provision` (`chain-wire.ts`, provisioning's own file), so this stays a
 *  one-line, no-interface-change change here. */
export function branchFor(ticket: string): string {
  if (ticket.toLowerCase().startsWith(HOTFIX_TICKET_PREFIX)) {
    return `hotfix/${ticket.slice(HOTFIX_TICKET_PREFIX.length).toLowerCase()}`;
  }
  return `feature/${ticket.toLowerCase()}`;
}

/** A.6: `FORGE_HOTFIX_BASE`, falling back to the repo's ordinary base
 *  (`baseFor`) when unset -- ready for a hotfix-aware provisioning call to use once one
 *  exists; nothing in this stream's own files calls `ChainLauncher.provision` with a
 *  ticket-aware base today. */
export function hotfixBaseFor(chainEnv: ChainEnv, repo: string, env: NodeJS.ProcessEnv = process.env): string {
  return env['FORGE_HOTFIX_BASE'] ?? baseFor(chainEnv, repo);
}

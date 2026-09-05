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
function parseShellPrefix(raw: string | undefined): string[] {
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
  };
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
export function worktreePathFor(checkout: string, repo: string, ticket: string): string {
  const sep = checkout.includes('\\') && !checkout.includes('/') ? '\\' : '/';
  const parent = checkout.replace(/[/\\]+$/, '');
  const lastSep = Math.max(parent.lastIndexOf('/'), parent.lastIndexOf('\\'));
  const parentDir = lastSep === -1 ? '' : parent.slice(0, lastSep);
  const name = repo.split('/').pop()!.toLowerCase();
  return `${parentDir}${sep}worktrees${sep}${name}--${ticket.toLowerCase()}`;
}

export function branchFor(ticket: string): string {
  return `feature/${ticket.toLowerCase()}`;
}

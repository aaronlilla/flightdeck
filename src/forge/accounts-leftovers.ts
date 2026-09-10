/**
 * The login directories nobody is using any more.
 *
 * Unlinking an account drops its registry row and leaves its config directory alone, on
 * purpose (Aaron, 2026-09-10): the directory is hundreds of megabytes, removing it is
 * irreversible, and a kept one re-links with no browser login at all. That leaves the
 * files needing their own way out, which is what this module is.
 *
 * The design constraint is the whole point. A delete that takes a PATH from a browser is
 * a remote arbitrary-delete with a containment check standing between it and the disk,
 * and containment checks are exactly the thing that quietly stops working. So no path
 * ever crosses the wire here: a leftover is named by its DIRECTORY NAME, that name must
 * be a single segment matching the shape `accounts-connect.ts` mints, and it is resolved
 * by matching against the directories actually present under the configs root. A name
 * that does not appear in that listing cannot name anything, wherever it points.
 */
import { existsSync, readdirSync, rmSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import { loadAccounts, normalizeDir, type Verdict } from './accounts.js';
import { forgeHome } from './paths.js';

/** The same shape `accounts-connect.ts`'s `configDirFor` mints: `<provider>-<id>`. A
 *  name is only ever compared against this, never resolved as a path. */
const LEFTOVER_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export interface Leftover {
  name: string;
  bytes: number;
}

export function accountsConfigsRoot(): string {
  return join(forgeHome(), 'accounts', 'configs');
}

/** Every byte under a directory, following no symlinks. Best effort: a file that
 *  vanishes or refuses a stat mid-walk contributes nothing rather than throwing, because
 *  a size is a courtesy to the reader and never a reason to fail a listing. */
function bytesUnder(dir: string): number {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) total += bytesUnder(path);
      else if (entry.isFile()) total += statSync(path).size;
    } catch {
      // Gone between the listing and the stat. Not this function's problem.
    }
  }
  return total;
}

/** The set of directories a registered account is still authenticating through, in the
 *  one comparable form `normalizeDir` gives every path in this codebase. */
function liveDirs(registryPath?: string): Set<string> {
  const accounts = registryPath === undefined ? loadAccounts() : loadAccounts(registryPath);
  return new Set(accounts.map((account) => normalizeDir(account.configDir)));
}

/** Every directory under the configs root that no registered account is using. */
export function listLeftovers(registryPath?: string): Leftover[] {
  const root = accountsConfigsRoot();
  if (!existsSync(root)) return [];
  const live = liveDirs(registryPath);
  const out: Leftover[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !LEFTOVER_NAME.test(entry.name)) continue;
    const path = join(root, entry.name);
    if (live.has(normalizeDir(path))) continue;
    out.push({ name: entry.name, bytes: bytesUnder(path) });
  }
  return out;
}

export type DeleteLeftoverVerdict = { ok: true; bytes: number } | Verdict & { ok: false };

/**
 * Removes one leftover directory, by name.
 *
 * Three refusals, in order, and none of them is a path check because no path is
 * accepted: a name that is not one plain segment of the minted shape; a name that is not
 * in the configs listing right now; and a directory a registered account is still using.
 * `..`, `.`, an absolute path and anything with a separator all fail the first test and
 * never reach the filesystem.
 */
export function deleteLeftover(name: string, registryPath?: string): DeleteLeftoverVerdict {
  if (!LEFTOVER_NAME.test(name)) {
    return { ok: false, reason: 'that is not the name of a login directory' };
  }
  const root = accountsConfigsRoot();
  let present: string[];
  try {
    present = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { ok: false, reason: 'there are no login directories to remove' };
  }
  if (!present.includes(name)) {
    return { ok: false, reason: `no leftover login directory named '${name}'` };
  }

  const path = join(root, name);
  if (liveDirs(registryPath).has(normalizeDir(path))) {
    return { ok: false, reason: `'${name}' is still linked; unlink the account first` };
  }

  const bytes = bytesUnder(path);
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, bytes };
}

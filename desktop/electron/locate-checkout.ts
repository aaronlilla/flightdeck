/**
 * Where the app finds a Forge checkout to run `forge up` from.
 *
 * Order: FORGE_REPO_DIR, then a path the user picked before (read from
 * settings), then the directory the app is installed beside, if that looks
 * like the repository. No path is hardcoded; every candidate comes from the
 * environment, a settings file, or the app's own install location, and each
 * candidate is checked before it is trusted.
 */
export interface LocateFs {
  existsSync(path: string): boolean;
}

export interface LocateEnv {
  FORGE_REPO_DIR?: string;
}

export interface LocateCandidates {
  env: LocateEnv;
  rememberedCheckoutDir?: string;
  installDir?: string;
  join(...parts: string[]): string;
}

/** True when `dir` looks like a checkout of this repository: it has the
 *  package.json and the built forge CLI entry, or the source entry a
 *  checkout without a build still has. */
export function looksLikeForgeRepo(fs: LocateFs, join: (...p: string[]) => string, dir: string): boolean {
  if (!fs.existsSync(join(dir, 'package.json'))) return false;
  const hasBuiltEntry = fs.existsSync(join(dir, 'dist', 'forge', 'cli.js'));
  const hasSourceEntry = fs.existsSync(join(dir, 'src', 'forge', 'cli.ts'));
  return hasBuiltEntry || hasSourceEntry;
}

export interface LocateResult {
  dir: string;
  source: 'env' | 'remembered' | 'install-dir';
}

/**
 * Resolve a checkout, or return undefined when none of the candidates
 * check out. Undefined means the caller should ask the user to pick one.
 */
export function locateCheckout(fs: LocateFs, candidates: LocateCandidates): LocateResult | undefined {
  const { env, rememberedCheckoutDir, installDir, join } = candidates;

  if (env.FORGE_REPO_DIR && looksLikeForgeRepo(fs, join, env.FORGE_REPO_DIR)) {
    return { dir: env.FORGE_REPO_DIR, source: 'env' };
  }

  if (rememberedCheckoutDir && looksLikeForgeRepo(fs, join, rememberedCheckoutDir)) {
    return { dir: rememberedCheckoutDir, source: 'remembered' };
  }

  if (installDir && looksLikeForgeRepo(fs, join, installDir)) {
    return { dir: installDir, source: 'install-dir' };
  }

  return undefined;
}

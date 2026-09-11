/**
 * Where the app finds a Forge checkout to run `forge up` from.
 *
 * It never falls back (Aaron, 2026-09-11: "I don't want the console to ever fallback,
 * why would I want that"). Falling back meant quietly running a directory the operator
 * did not choose, and it hid a real misconfiguration for days: an environment variable
 * and the saved checkout file pointed at different trees, the ranking silently preferred
 * one, and nothing a start printed said which.
 *
 * So a configured candidate that is broken, or two that disagree, is a REFUSAL naming
 * what was found and where. Only an unambiguous answer resolves, and it carries the
 * source so the caller can say how it was chosen. A machine with nothing configured is
 * its own outcome, so the caller can still ask the operator to pick a folder.
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
  /** `~/.forge/console.checkout`'s content, read by the caller via `readCheckoutFile`. */
  checkoutFileDir?: string;
  /** A directory the operator was asked for and chose. Not a fallback: it is the one
   *  explicit decision here, so it SETTLES a disagreement rather than joining it -- a
   *  pick that merely became a fourth candidate left the refusal unendable. Still
   *  checked before it is trusted. */
  pickedDir?: string;
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

export type LocateSource = 'picked' | 'env' | 'remembered' | 'checkout-file' | 'install-dir';

export type LocateOutcome =
  /** One unambiguous checkout. `source` is how it was chosen, for reporting. */
  | { kind: 'ok'; dir: string; source: LocateSource }
  /** Something IS configured and cannot be trusted. Never resolve past this. */
  | { kind: 'refused'; refusal: string }
  /** Nothing is configured at all: the caller asks the operator to pick a folder. */
  | { kind: 'unconfigured' };

/** How each candidate is named in a refusal, so the operator knows what to go and fix. */
const WHERE: Record<LocateSource, string> = {
  picked: 'the folder you picked',
  env: 'the FORGE_REPO_DIR environment variable',
  remembered: 'the checkout remembered in settings',
  'checkout-file': 'the saved path in ~/.forge/console.checkout',
  'install-dir': 'the directory the app is installed beside',
};

/**
 * One directory, spelled two ways, is one directory. The folder picker writes Windows
 * backslashes while `~/.forge/console.checkout` is hand-written and usually has forward
 * slashes, so comparing raw strings would refuse a machine that is correctly configured
 * -- worse than the silent ranking this replaced.
 */
function tidy(dir: string): string {
  const forward = dir.replace(/\\/g, '/');
  return forward.length > 1 ? forward.replace(/\/+$/, '') : forward;
}

function sameDirKey(dir: string): string {
  return tidy(dir).toLowerCase();
}

export function locateCheckout(fs: LocateFs, candidates: LocateCandidates): LocateOutcome {
  const {
    env, rememberedCheckoutDir, checkoutFileDir, pickedDir, installDir, join,
  } = candidates;

  // An explicit pick outranks every setting and ends any disagreement between them. It
  // is still verified: trusting a mis-pick would write a broken candidate that refuses
  // every later launch.
  if (pickedDir) {
    const picked = tidy(pickedDir);
    if (!looksLikeForgeRepo(fs, join, picked)) {
      return {
        kind: 'refused',
        refusal: `${WHERE['picked']} is ${picked}, which is not a Forge checkout. Pick the folder that holds package.json.`,
      };
    }
    return { kind: 'ok', dir: picked, source: 'picked' };
  }

  // The install directory is where the app happens to live, not something anybody
  // configured, so it is only consulted when nothing else is and it never conflicts.
  const configured: Array<{ source: LocateSource; dir: string }> = [];
  if (env.FORGE_REPO_DIR) configured.push({ source: 'env', dir: tidy(env.FORGE_REPO_DIR) });
  if (rememberedCheckoutDir) configured.push({ source: 'remembered', dir: tidy(rememberedCheckoutDir) });
  if (checkoutFileDir) configured.push({ source: 'checkout-file', dir: tidy(checkoutFileDir) });

  // A configured candidate that is not a checkout is a broken setting, not a reason to
  // run a different directory. Refuse and name it.
  const broken = configured.find((c) => !looksLikeForgeRepo(fs, join, c.dir));
  if (broken) {
    return {
      kind: 'refused',
      refusal: `${WHERE[broken.source]} points at ${broken.dir}, which is not a Forge checkout. `
        + 'Fix it or clear it; nothing else will be run in its place.',
    };
  }

  // Two settings that disagree mean nobody has decided which tree serves. Picking the
  // higher-ranked one is exactly the silent choice this function exists to stop making.
  const distinct = [...new Set(configured.map((c) => sameDirKey(c.dir)))];
  if (distinct.length > 1) {
    const named = configured.map((c) => `${WHERE[c.source]} -> ${c.dir}`).join('; ');
    return {
      kind: 'refused',
      refusal: `Configured checkouts disagree, so none was chosen: ${named}. `
        + 'Point them at the same directory, or clear the ones that are wrong.',
    };
  }

  const agreed = configured[0];
  if (agreed) return { kind: 'ok', dir: agreed.dir, source: agreed.source };

  if (installDir && looksLikeForgeRepo(fs, join, installDir)) {
    return { kind: 'ok', dir: installDir, source: 'install-dir' };
  }

  return { kind: 'unconfigured' };
}

/** What the app should do with a resolution outcome: which directory to use, what to
 *  tell the operator, and whether to offer the folder picker. */
export interface CheckoutPrompt {
  dir?: string;
  /** The sentence shown in the status window. Absent when a checkout resolved. */
  status?: string;
  /** The line written to the status log either way, so a start is never silent. */
  log: string;
  /** Whether to offer the folder picker. A refusal MUST offer it: refusing to guess is
   *  the point, but leaving no way back would mean an app that cannot start at all. */
  pickFolder: boolean;
}

export function checkoutPrompt(outcome: LocateOutcome): CheckoutPrompt {
  if (outcome.kind === 'ok') {
    return { dir: outcome.dir, log: `checkout ${outcome.dir} (from ${outcome.source})`, pickFolder: false };
  }
  if (outcome.kind === 'refused') {
    return { status: outcome.refusal, log: `checkout refused: ${outcome.refusal}`, pickFolder: true };
  }
  return {
    status: 'Could not find a Forge checkout. Pick the repository folder to continue.',
    log: 'checkout not configured', pickFolder: true,
  };
}

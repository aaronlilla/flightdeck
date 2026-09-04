/**
 * Installing Forge where the thing it replaces is already installed.
 *
 * Aaron, 2026-09-04: the installer must also uninstall what it supersedes. Two
 * supervisors side by side is the exact failure this sub-project exists to prevent. On
 * 2026-09-03 a wake from one and a recycle from the other landed twelve seconds apart and
 * the goal came out of the exchange holding no session at all; installing Forge next to
 * the old conductor would make that the normal case rather than a race.
 *
 * This is the half that looks and refuses. It surveys what the old runtime has on the
 * machine, writes a plan naming every file that would go and what replaces it, and
 * refuses to install while the old conductor is still running. The removal itself is
 * Stage C, driven from this plan.
 *
 * The split is deliberate. A half-applied install on this machine today left
 * `model_policy.py` present and `model-policy.json` missing, which crashed a hook on
 * every plan tool, and nothing could say which half had been applied. A plan that is
 * written, read and then executed is the opposite of that.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FoundFile {
  name: string;
  path: string;
}

export interface Survey {
  present: boolean;
  found: FoundFile[];
  coordination: string;
}

/**
 * Files that belong to the runtime Forge replaces.
 *
 * Named rather than matched by a wildcard: `coordination/` also holds things Forge does
 * not replace, and a glob that swept those up would be an installer deleting files it
 * was never asked about.
 */
const OLD_RUNTIME = [
  /^conductor.*\.(py|cmd|json)$/i,
  /^go\.py$/i,
  /^terminals\.py$/i,
  /^tile.*\.(ps1|vbs|cmd)$/i,
];

/** What replaces each of them, so the plan says what is lost as well as what goes. */
const REPLACED_BY: Record<string, string> = {
  'conductor.py': 'forge supervisor.ts and the runner loop',
  'conductor_alive.py': 'lane records with owner, and the journal',
  'conductor_check.py': 'forge status, and /state on 4120',
  'conductor_events.py': 'journal.ts',
  'conductor_jobs.py': 'forge cli.ts',
  'go.py': 'forge worker.ts and launcher.ts',
  'terminals.py': 'the SDK subprocess; there are no terminals to spawn',
  'tile.ps1': 'the dashboard, and later the console',
  'tile-watch.vbs': 'the dashboard, and later the console',
  'tile-watch.cmd': 'the dashboard, and later the console',
  'conductor-worker.cmd': 'forge run',
};

/**
 * Things that are never proposed for removal, whatever else goes.
 *
 * A guard removed by an installer is a guard that stops guarding at exactly the moment
 * the machine is changing. The model policy is on the list for the same reason: Stage C
 * points the old conductor at Forge's copy rather than deleting either.
 *
 * Only `conductor_hooks.py` is exercised by the suite, because it is the only one the
 * survey above currently matches. The rest are cover for a future widening of that
 * survey and are not proven today; the specimen says so rather than implying otherwise.
 */
const NEVER_REMOVE = [
  /_guard\.py$/i,
  /model-policy\.json$/i,
  /model_policy\.py$/i,
  // The PreToolUse and PostToolUse pair the worker settings wire up. Removing it while a
  // worker is mid-flight takes the hooks out from under a running session, which is the
  // half-applied install failure again by another road.
  /conductor_hooks\.py$/i,
];

export function surveyOldRuntime(home: string): Survey {
  const coordination = join(home, '.claude', 'coordination');
  if (!existsSync(coordination)) return { present: false, found: [], coordination };
  const found = readdirSync(coordination)
    .filter((name) => OLD_RUNTIME.some((pattern) => pattern.test(name)))
    .sort()
    .map((name) => ({ name, path: join(coordination, name) }));
  return { present: found.length > 0, found, coordination };
}

export interface UninstallItem {
  name: string;
  path: string;
  replacedBy: string;
}

export interface UninstallPlan {
  at: number;
  remove: UninstallItem[];
  keep: string[];
}

/**
 * What Stage C would remove, written down and nothing more.
 *
 * Removes nothing. The whole point is that the list is read before it is acted on.
 */
export function planUninstall(home: string, writeTo?: string): UninstallPlan {
  const survey = surveyOldRuntime(home);
  const remove = survey.found
    .filter((file) => !NEVER_REMOVE.some((pattern) => pattern.test(file.path)))
    .map((file) => ({
      ...file,
      replacedBy: REPLACED_BY[file.name] ?? 'nothing yet; this one needs a decision',
    }));

  const plan: UninstallPlan = {
    at: Date.now(),
    remove,
    keep: ['every *_guard.py', 'model-policy.json', 'model_policy.py',
      'coordlib.py and slots.py, which Forge does not replace'],
  };
  if (writeTo) {
    mkdirSync(join(writeTo, '..'), { recursive: true });
    writeFileSync(writeTo, JSON.stringify(plan, null, 2), 'utf8');
  }
  return plan;
}

export interface InstallVerdict {
  ok: boolean;
  refusals: string[];
  notes: string[];
}

/**
 * Whether Forge may be installed on this machine right now.
 *
 * A running conductor is a refusal rather than a warning: installing under a live
 * supervisor is how a machine ends up with two of them, and the second one starts
 * supervising the first one's lanes before anybody notices.
 */
export function checkInstall(
  home: string, state: { conductorRunning: boolean },
): InstallVerdict {
  const refusals: string[] = [];
  const notes: string[] = [];
  const survey = surveyOldRuntime(home);

  if (state.conductorRunning) {
    refusals.push('the old conductor is running; stop it before installing, or the machine '
      + 'ends up with two supervisors and each will act on the other\'s lanes');
  }
  if (survey.present) {
    notes.push(`the old runtime is installed here (${survey.found.length} file(s)); `
      + 'run the uninstall plan before relying on Forge, or both will supervise');
  }
  return { ok: refusals.length === 0, refusals, notes };
}

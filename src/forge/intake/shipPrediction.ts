/**
 * Item 16, 2026-09-12: what merging this pull request is predicted to cost, per
 * platform.
 *
 * The pull request that reached review on 2026-09-11 said nothing about whether
 * merging publishes an over-the-air update or triggers a rebuild, though the decide
 * job had already resolved `android_action: update`. Whoever merged it could not tell,
 * and the two platforms can differ: a file under `android/` rebuilds Android and
 * leaves iOS on an update.
 *
 * **This is a prediction, never a reading.** The build fingerprint is ground truth and
 * it is computed from the whole resolved tree, not from a file list; a dependency bump
 * that pulls in native code does not have to touch a single native path. So every
 * sentence this module renders says so, and an empty file list yields `unknown` rather
 * than the cheerful answer.
 */

export type ShipAction = 'update' | 'rebuild' | 'unknown';

export interface ShipPrediction {
  android: ShipAction;
  ios: ShipAction;
  /** The paths the prediction rests on, so a reader can check it rather than trust it.
   *  Empty when nothing in the diff moved either platform off an update. */
  signals: string[];
}

/** A path that rebuilds Android and nothing else. */
const ANDROID_ONLY = /^android[/\\]/i;
/** A path that rebuilds iOS and nothing else. */
const IOS_ONLY = /^ios[/\\]/i;
/**
 * A path that rebuilds both. A patch rewrites a package's own source, native included,
 * and the manifest or lockfile can pull in native code without naming a native path --
 * neither can be taken over the air, and the file list alone cannot prove otherwise.
 * The build config files are here for the same reason (code review, 2026-09-12): a
 * change to `app.config.js`, `app.json` or `eas.json` moves the fingerprint without
 * naming a single native path, so a config-only change predicted an update and got a
 * rebuild.
 */
const BOTH = /^patches[/\\]|^(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|app\.json|app\.config\.[jt]s|eas\.json)$/i;

export function shipPredictionFor(changedFiles: readonly string[]): ShipPrediction {
  if (changedFiles.length === 0) return { android: 'unknown', ios: 'unknown', signals: [] };

  const signals: string[] = [];
  let android: ShipAction = 'update';
  let ios: ShipAction = 'update';

  for (const file of changedFiles) {
    const normalised = file.replace(/\\/g, '/');
    if (BOTH.test(normalised)) {
      android = 'rebuild';
      ios = 'rebuild';
      signals.push(file);
    } else if (ANDROID_ONLY.test(normalised)) {
      android = 'rebuild';
      signals.push(file);
    } else if (IOS_ONLY.test(normalised)) {
      ios = 'rebuild';
      signals.push(file);
    }
  }

  return { android, ios, signals };
}

function sentenceFor(platform: string, action: ShipAction): string {
  if (action === 'rebuild') return `${platform}: predicted rebuild.`;
  return `${platform}: predicted over-the-air update.`;
}

/** The block appended to a pull request body at review. Both platforms are always
 *  named, because a prediction that mentions one reads as silence about the other. */
export function renderShipPrediction(prediction: ShipPrediction): string {
  if (prediction.android === 'unknown' || prediction.ios === 'unknown') {
    return 'Ship path: could not read the changed files, so neither platform is predicted here.'
      + ' The build fingerprint decides.';
  }
  const lines = [
    'Ship path (predicted, not measured -- the build fingerprint decides):',
    `- ${sentenceFor('Android', prediction.android)}`,
    `- ${sentenceFor('iOS', prediction.ios)}`,
  ];
  if (prediction.signals.length) {
    lines.push(`Read from: ${prediction.signals.join(', ')}.`);
  } else {
    lines.push('Read from: no native paths, patches or dependency manifests in this diff.');
  }
  return lines.join('\n');
}

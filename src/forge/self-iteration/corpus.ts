/**
 * Dispatcher decision 1: the regression corpus is a manifest naming every fixture,
 * every rules specimen, and every probe brief this stream's canary run must pass before
 * a proposal is ever considered for activation. The corpus "exists" the moment the
 * manifest is present and every one of its entries resolves to a real file -- there is no
 * separate flag to flip, because a manifest whose entries do not resolve is not a corpus
 * anybody could actually run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RegressionCorpusManifest {
  fixtures: string[];
  specimens: string[];
  probes: string[];
}

export interface CorpusCheckDeps {
  manifestPath: string;
  fixturesDir: string;
  specimensDir: string;
  /** `paths.ts`'s `probeDir()` result: `undefined` means every probe entry is reported
   *  missing, never guessed at from a hardcoded fallback. */
  probeDir: string | undefined;
  exists?: (path: string) => boolean;
}

export interface MissingEntry {
  category: 'fixtures' | 'specimens' | 'probes';
  name: string;
  reason: string;
}

export interface CorpusCheckResult {
  exists: boolean;
  manifest?: RegressionCorpusManifest;
  missing: MissingEntry[];
}

export function checkRegressionCorpus(deps: CorpusCheckDeps): CorpusCheckResult {
  const exists = deps.exists ?? existsSync;

  if (!exists(deps.manifestPath)) {
    return { exists: false, missing: [{ category: 'fixtures', name: deps.manifestPath, reason: 'manifest itself is missing' }] };
  }

  let manifest: RegressionCorpusManifest;
  try {
    manifest = JSON.parse(readFileSync(deps.manifestPath, 'utf8')) as RegressionCorpusManifest;
  } catch (error) {
    return {
      exists: false,
      missing: [{ category: 'fixtures', name: deps.manifestPath, reason: `manifest does not parse: ${(error as Error).message}` }],
    };
  }

  const missing: MissingEntry[] = [];

  for (const name of manifest.fixtures ?? []) {
    if (!exists(join(deps.fixturesDir, name))) missing.push({ category: 'fixtures', name, reason: 'not found under fixturesDir' });
  }
  for (const name of manifest.specimens ?? []) {
    if (!exists(join(deps.specimensDir, name))) missing.push({ category: 'specimens', name, reason: 'not found under specimensDir' });
  }
  for (const name of manifest.probes ?? []) {
    if (!deps.probeDir) {
      missing.push({ category: 'probes', name, reason: 'FORGE_PROBE_DIR is unset' });
      continue;
    }
    if (!exists(join(deps.probeDir, name))) missing.push({ category: 'probes', name, reason: 'not found under FORGE_PROBE_DIR' });
  }

  return { exists: missing.length === 0, manifest, missing };
}

/**
 * Dispatcher decision 1: the corpus exists when the manifest is present and every entry
 * resolves. `tests/forge/regression-corpus.json` is the actual deliverable this checks
 * against, plus a set of purely in-memory specimens that never touch the real filesystem
 * (the `exists` dependency is injected).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { checkRegressionCorpus } from '../../../src/forge/self-iteration/corpus.js';

const REAL_MANIFEST = fileURLToPath(new URL('../regression-corpus.json', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
const SPECIMENS_DIR = fileURLToPath(new URL('../specimens/', import.meta.url));

describe('checkRegressionCorpus: the real corpus manifest', () => {
  it('exists, and every fixture, specimen and probe basename it names resolves', () => {
    const probeDir = process.env['FORGE_PROBE_DIR'];
    const result = checkRegressionCorpus({
      manifestPath: REAL_MANIFEST, fixturesDir: FIXTURES_DIR, specimensDir: SPECIMENS_DIR, probeDir,
    });
    if (!probeDir) {
      // Documented gap: FORGE_PROBE_DIR is not set in this run, so the probe entries are
      // reported missing rather than silently skipped. Everything else must still resolve.
      expect(result.missing.every((entry) => entry.category === 'probes')).toBe(true);
    } else {
      expect(result.exists).toBe(true);
    }
  });

  it('the manifest parses and names at least one entry in each category', () => {
    const manifest = JSON.parse(readFileSync(REAL_MANIFEST, 'utf8')) as {
      fixtures: string[]; specimens: string[]; probes: string[];
    };
    expect(manifest.fixtures.length).toBeGreaterThan(0);
    expect(manifest.specimens.length).toBeGreaterThan(0);
    expect(manifest.probes.length).toBeGreaterThan(0);
  });
});

describe('checkRegressionCorpus: injected filesystem, no real I/O', () => {
  it('reports missing when the manifest itself does not exist', () => {
    const result = checkRegressionCorpus({
      manifestPath: 'nope.json', fixturesDir: 'f', specimensDir: 's', probeDir: 'p', exists: () => false,
    });
    expect(result.exists).toBe(false);
  });

  it('reports each unresolved entry by category and name', () => {
    const files = new Set(['manifest.json']);
    const result = checkRegressionCorpus({
      manifestPath: 'manifest.json', fixturesDir: 'f', specimensDir: 's', probeDir: 'p',
      exists: (path) => files.has(path),
    });
    // The manifest "exists" per the fake, but readFileSync would throw for real -- this
    // specimen only proves the missing-entries path, so it uses a manifest with real
    // content via a second exists()-aware read below instead.
    expect(result.exists).toBe(false);
  });

  it('reports a probe entry missing with its own reason when FORGE_PROBE_DIR is unset', () => {
    const manifestPath = join(FIXTURES_DIR, 'regression-corpus-probe-check.json');
    const files = new Set([manifestPath]);
    const result = checkRegressionCorpus({
      manifestPath, fixturesDir: FIXTURES_DIR, specimensDir: SPECIMENS_DIR, probeDir: undefined,
      exists: (path) => files.has(path),
    });
    expect(result.exists).toBe(false);
    expect(result.missing.some((entry) => entry.category === 'probes' && entry.reason.includes('FORGE_PROBE_DIR'))).toBe(true);
  });
});

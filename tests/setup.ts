/**
 * Test setup.
 *
 * Ink checks whether it is running in CI and, when it thinks it is, stops
 * drawing frames as it goes so it does not fill a build log with redraws. That
 * is sensible for a program printing output and wrong for a test that reads the
 * screen: every screen assertion compared against an empty string on the build
 * machine while passing locally.
 *
 * Clearing the detection here makes the tests exercise the interactive render
 * path, which is the only path that ever runs on a real machine. It changes how
 * Ink draws and nothing about what is asserted.
 *
 * This runs before each test file, and therefore before Ink is imported, which
 * matters because the detection is evaluated once when its module loads.
 */
for (const name of [
  'CI',
  'GITHUB_ACTIONS',
  'BUILD_NUMBER',
  'RUN_ID',
  'CONTINUOUS_INTEGRATION',
]) {
  delete process.env[name];
}

/**
 * This suite runs on the same machine that drives the real fleet. Every `FORGE_*`
 * variable the real deployment needs (`FORGE_CONFIG_DIR`, `FORGE_GH_BACKEND_OWNER`,
 * `FORGE_REPO_VERIFY`, and dozens more) is already sitting in this shell's environment.
 * A test meant to prove "no override present, defaults apply" was silently reading this
 * machine's real production config instead. `buildWorkerOptions()` pinned the fleet's
 * actual `.claude-fleet` directory rather than the specimen's temp one, and a queue-item
 * `plain` sentence read the real backend owner rather than the null the specimen expected.
 * Both passed on a machine with no `FORGE_*` config, so CI never caught them, and both
 * failed here first. Stripped once per test file, same as the CI markers above, so every
 * specimen that wants a `FORGE_*` value sets it itself instead of inheriting the operator's.
 */
for (const name of Object.keys(process.env)) {
  if (name.startsWith('FORGE_')) delete process.env[name];
}

/**
 * Stripping `FORGE_HOME` leaves `forgeHome()` on its default, which is the operator's
 * own `~/.forge` -- the live console's queue, journal and rail thread. On 2026-09-12 a
 * new specimen that built a `ConductorAgent` without setting `FORGE_HOME` itself wrote
 * eight scripted replies ("first", "second") straight into the running console's rail,
 * where the operator read them beside real answers.
 *
 * So the strip above is followed by a home of our own: an empty directory per test file,
 * removed when the file ends. A specimen that wants its own still sets `FORGE_HOME`, as
 * every existing one already does; what changes is that forgetting to now writes into a
 * temp directory instead of into the machine the suite is running on.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const suiteHome = mkdtempSync(join(tmpdir(), 'forge-suite-home-'));
process.env['FORGE_HOME'] = suiteHome;
process.on('exit', () => { try { rmSync(suiteHome, { recursive: true, force: true }); } catch { /* a temp dir left behind is not worth failing a run over */ } });

/**
 * The readability contract (order 19) is machine data, never repo data (R-59,
 * 2026-09-10) -- a real contract names real repos and real PR prose, which this repo's
 * `check:agnostic` forbids. Every test file gets the neutral in-repo specimen set by
 * default, same as the real machine gets the real one from `install.ps1`. A specimen
 * that wants a different contract (a missing dir, a malformed file) overrides this
 * itself and calls `resetReadabilityContractForTests()`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
process.env['FORGE_READABILITY_DIR'] = join(dirname(fileURLToPath(import.meta.url)), 'forge', 'specimens', 'readability');

/**
 * The SDK's own `query` throws in every test in this suite.
 *
 * Nothing under test is allowed to reach the model: every session specimen injects its
 * own fake in place of `query`, and this makes that a property the whole suite enforces
 * rather than a habit each file has to remember. A test that forgot to inject a fake, or
 * a production path that fell back to the real export, fails here instead of spending
 * money the next time it runs against a live login.
 */
import '@testing-library/jest-dom/vitest';

import { afterEach, vi } from 'vitest';

/**
 * React Testing Library only auto-registers its `cleanup` when it detects
 * Jest-style globals; this suite imports `afterEach` per file instead, so
 * nothing unmounted a previous test's tree without this. Every console
 * component test would otherwise see the previous test's DOM stacked on top
 * of its own.
 */
try {
  const { cleanup } = await import('@testing-library/react');
  afterEach(cleanup);
} catch {
  // Not every test file renders React; the module is optional here.
}

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  return {
    ...actual,
    query: () => {
      throw new Error('the real SDK query() was called from inside the test suite; '
        + 'every session specimen must inject a fake queryFn instead');
    },
  };
});

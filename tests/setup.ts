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

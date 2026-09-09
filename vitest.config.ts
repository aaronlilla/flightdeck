import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    // Clears the CI detection that would otherwise stop Ink drawing frames, so
    // the interface tests read the same render path a real machine uses.
    setupFiles: ['./tests/setup.ts'],
    // The cockpit renders to a fake stdout; give it a stable terminal width so
    // snapshot-style assertions do not depend on the developer's window size.
    env: { COLUMNS: '100', FLIGHTDECK_TEST: '1' },
    // A handful of specimens in tests/forge/console/reads.test.ts and
    // tests/forge/console/rail.test.tsx do nothing but synchronous, in-memory work and
    // run in well under 100ms alone, yet time out at the 5000ms default when the full
    // suite runs in parallel -- other files in the same run spawn real `git clone`
    // processes (chain-rebase specimens) that starve the test worker pool for CPU and
    // disk I/O on this machine. Confirmed by running the failing file alone: it passes
    // every time, in under 3s total. Raised rather than disabled, so an actual hang
    // still fails the suite; this only buys headroom against contention that has
    // nothing to do with the test's own logic.
    testTimeout: 15000,
  },
});

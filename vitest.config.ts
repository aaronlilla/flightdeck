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
    // The default 5s test timeout is too tight for a full run: this suite has
    // 3000+ tests, many of which spawn the real forge CLI as a subprocess, and
    // under the full-suite worker load unrelated tests intermittently starve
    // past 5s even with no slow work of their own (observed on
    // tests/forge/cli.test.ts and tests/forge/console/reads.test.ts on
    // consecutive full runs, each passing in under 3s in isolation). Individual
    // tests already opt into 20_000ms for known subprocess-heavy cases; making
    // that the suite default removes the whack-a-mole.
    testTimeout: 20_000,
  },
});

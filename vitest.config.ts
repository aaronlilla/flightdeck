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
  },
});

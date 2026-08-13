import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    // The cockpit renders to a fake stdout; give it a stable terminal width so
    // snapshot-style assertions do not depend on the developer's window size.
    env: { COLUMNS: '100', FLIGHTDECK_TEST: '1' },
  },
});

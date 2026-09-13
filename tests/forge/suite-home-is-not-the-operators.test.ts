import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { forgeHome } from '../../src/forge/paths.js';

/**
 * 2026-09-12: a specimen that built a `ConductorAgent` without naming its own home wrote
 * eight scripted replies into the running console's rail, where the operator read them
 * beside real answers. `tests/setup.ts` strips every `FORGE_*` variable so no test reads
 * the machine's real config, and the default left behind was the machine's real config.
 *
 * This is the backstop on that: whatever a file does or forgets, the suite's idea of home
 * is never the operator's.
 */
describe('where the suite thinks the fleet lives', () => {
  it('is never the operator\'s own directory', () => {
    const operator = join(homedir(), '.forge');
    expect(process.env['FORGE_HOME'], 'the suite runs with no home of its own').toBeTruthy();
    expect(forgeHome()).not.toBe(operator);
  });
});

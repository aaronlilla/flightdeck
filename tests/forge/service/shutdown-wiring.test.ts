/**
 * Proves `forge up` actually wires the graceful-stop handler rather than just shipping
 * the module unused. A unit test on `installShutdown` alone cannot catch that -- this
 * reads the real `cli.ts` source and asserts the call exists inside the `up` case, wired
 * to the real server, the real tick and a real journal (not a stub standing in for them).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const cliSource = readFileSync(join(__dirname, '../../../src/forge/cli.ts'), 'utf8');

describe('cli.ts up wiring: installShutdown', () => {
  it('imports installShutdown from the service module', () => {
    expect(cliSource).toMatch(/import\s*\{\s*installShutdown\s*\}\s*from\s*['"]\.\/service\/shutdown\.js['"]/);
  });

  it('calls installShutdown inside the up case, wired to the real server, tick and journal', () => {
    const upCaseStart = cliSource.indexOf("case 'up': {");
    expect(upCaseStart).toBeGreaterThan(-1);
    const callIndex = cliSource.indexOf('installShutdown({', upCaseStart);
    expect(callIndex).toBeGreaterThan(upCaseStart);
    const block = cliSource.slice(callIndex, callIndex + 400);
    expect(block).toMatch(/server,/);
    expect(block).toMatch(/clearTick:\s*\(\)\s*=>\s*clearInterval\(tick\)/);
    expect(block).toMatch(/journal:\s*shutdownJournal/);
  });
});

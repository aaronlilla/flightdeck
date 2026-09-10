/**
 * Proves the tick body in `cli.ts` actually calls the elapsed clock and the orphan
 * sweep on every 30s tick -- a unit test on `SessionClock`/`sweepFinishedRun` alone
 * cannot catch a wiring gap where the real module never gets called.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const cliSource = readFileSync(join(__dirname, '../../../src/forge/cli.ts'), 'utf8');

describe('cli.ts tick wiring: session-clock and sweep', () => {
  it('imports SessionClock and sweepFinishedRun', () => {
    expect(cliSource).toMatch(/import\s*\{\s*SessionClock\s*\}\s*from\s*['"]\.\/session-clock\.js['"]/);
    expect(cliSource).toMatch(/import\s*\{\s*sweepFinishedRun\s*\}\s*from\s*['"]\.\/sweep\.js['"]/);
  });

  it('calls sessionClock.tick(...) inside the up case\'s setInterval body', () => {
    const upCaseStart = cliSource.indexOf("case 'up': {");
    const tickStart = cliSource.indexOf('const tick = setInterval(', upCaseStart);
    expect(tickStart).toBeGreaterThan(upCaseStart);
    const tickEnd = cliSource.indexOf('tick.unref();', tickStart);
    const tickBody = cliSource.slice(tickStart, tickEnd);
    expect(tickBody).toMatch(/sessionClock\.tick\(/);
    expect(tickBody).toMatch(/sweepFinishedRun\(/);
  });

  it('calls transcriptDrift.check(...) inside the same tick body, on the drift cadence', () => {
    const upCaseStart = cliSource.indexOf("case 'up': {");
    const tickStart = cliSource.indexOf('const tick = setInterval(', upCaseStart);
    const tickEnd = cliSource.indexOf('tick.unref();', tickStart);
    const tickBody = cliSource.slice(tickStart, tickEnd);
    expect(tickBody).toMatch(/transcriptDrift\.check\(/);
    expect(tickBody).toMatch(/driftCadence\.isDue\(/);
  });

  it('the sweep kill function\'s actual taskkill argv never carries /T', () => {
    const killIndex = cliSource.indexOf('const killPid');
    expect(killIndex).toBeGreaterThan(-1);
    const spawnIndex = cliSource.indexOf("spawn('taskkill'", killIndex);
    expect(spawnIndex).toBeGreaterThan(killIndex);
    const spawnLine = cliSource.slice(spawnIndex, cliSource.indexOf('\n', spawnIndex));
    expect(spawnLine).not.toMatch(/\/T\b/);
    expect(spawnLine).toMatch(/\/F/);
    expect(spawnLine).toMatch(/\/PID/);
  });
});

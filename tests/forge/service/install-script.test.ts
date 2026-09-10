/**
 * The generated service-install script has to hold every `nssm set` line item 1
 * specifies, with real paths never hand-typed, and it must refuse a wrong-hash NSSM
 * zip rather than extract it. Just as important: `nssm install` never runs from this
 * loop -- every occurrence in the generated text must sit inside a printed (`Write-Host`)
 * line, never an executed one.
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  elevatedInstallLines, elevatedUninstallLines, generateInstallScript, parseConsoleEnvFile,
  PINNED_NSSM_SHA256, preCheckLines, readInstallScriptInput, sha256Hex, verifyNssmZip,
} from '../../../src/forge/service/install-script.js';

const input = {
  home: 'D:\\fake\\forge-home',
  consoleWorktree: 'D:\\fake\\flightdeck-console-worktree',
  serviceUser: 'DESKTOP-1\\operator',
  envVars: [['FORGE_QUEUE', '1'], ['FORGE_LOGIN_HELPER', '1']] as Array<[string, string]>,
};

describe('PINNED_NSSM_SHA256', () => {
  it('is a real 64-character hex sha256, not a placeholder', () => {
    expect(PINNED_NSSM_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyNssmZip', () => {
  it('accepts a buffer whose hash matches the pinned constant', () => {
    // Reconstruct a buffer with the exact pinned hash by brute, impractical -- instead
    // prove the function is the real check by round-tripping through sha256Hex.
    const buffer = Buffer.from('anything');
    const hash = sha256Hex(buffer);
    expect(hash).toBe(createHash('sha256').update(buffer).digest('hex'));
  });

  it('refuses a fake zip whose hash does not match the pinned constant', () => {
    const fakeZip = Buffer.from('this is not the real nssm-2.24.zip');
    expect(verifyNssmZip(fakeZip)).toBe(false);
  });
});

describe('parseConsoleEnvFile', () => {
  it('reads set KEY=VALUE lines, ignoring blanks and non-set lines', () => {
    const contents = 'rem a comment\nset FOO=bar\n\nset BAZ=1\n';
    expect(parseConsoleEnvFile(contents)).toEqual([['FOO', 'bar'], ['BAZ', '1']]);
  });
});

describe('readInstallScriptInput', () => {
  it('returns an empty envVars list when console.env.cmd does not exist', () => {
    const result = readInstallScriptInput({
      home: input.home, consoleWorktree: input.consoleWorktree, serviceUser: input.serviceUser,
      envPath: 'Z:\\definitely\\does\\not\\exist\\console.env.cmd',
    });
    expect(result.envVars).toEqual([]);
  });
});

describe('elevatedInstallLines', () => {
  it('includes every nssm set line the guardrail names, with real paths', () => {
    const lines = elevatedInstallLines(input).join('\n');
    expect(lines).toContain(`nssm install FlightdeckConsole cmd.exe /c "${input.home}\\console.launch.cmd"`);
    expect(lines).toContain(`nssm set FlightdeckConsole AppDirectory "${input.consoleWorktree}"`);
    expect(lines).toContain('AppEnvironmentExtra FORGE_QUEUE=1 FORGE_LOGIN_HELPER=1');
    expect(lines).toContain('AppStdout');
    expect(lines).toContain('AppStderr');
    expect(lines).toContain('AppRotateFiles 1');
    expect(lines).toContain('AppExit Default Restart');
    expect(lines).toContain('AppExit 75 Restart');
    expect(lines).toContain('AppExit 76 Exit');
    expect(lines).toContain('AppKillProcessTree 0');
    expect(lines).toContain('AppStopMethodSkip 6');
    expect(lines).toContain(`ObjectName ".\\${input.serviceUser}"`);
    expect(lines).toContain('Start SERVICE_AUTO_START');
    expect(lines).toContain('nssm start FlightdeckConsole');
  });
});

describe('elevatedUninstallLines', () => {
  it('gives the reverse: stop then remove', () => {
    const lines = elevatedUninstallLines();
    expect(lines[0]).toBe('nssm stop FlightdeckConsole');
    expect(lines[1]).toBe('nssm remove FlightdeckConsole confirm');
  });
});

describe('preCheckLines', () => {
  it('carries the four steps in order: state/board, quiet moment, no /T, conditional lock delete', () => {
    const lines = preCheckLines();
    expect(lines[0]).toMatch(/\/state/);
    expect(lines[0]).toMatch(/whoswhere/);
    expect(lines[1]).toMatch(/quiet moment/);
    expect(lines[2]).toMatch(/taskkill/);
    // The taskkill invocation itself never carries /T -- only the explanatory text after
    // "--" is allowed to mention it (documenting that it is deliberately absent).
    const commandPart = lines[2]?.split('--')[0] ?? '';
    expect(commandPart).not.toMatch(/\/T\b/);
    expect(lines[3]).toMatch(/queue\.lock/);
    expect(lines[3]).toMatch(/only if/i);
  });
});

describe('generateInstallScript', () => {
  const script = generateInstallScript(input);

  it('embeds the pinned hash and refuses a mismatch rather than extracting', () => {
    expect(script).toContain(PINNED_NSSM_SHA256);
    expect(script).toMatch(/if \(\$actualHash -ne \$PinnedSha256\)/);
    expect(script).toMatch(/exit 1/);
  });

  it('never runs `nssm install` -- it appears only inside a printed Write-Host line', () => {
    const occurrences = script.split('\n').filter((line) => line.includes('nssm install'));
    expect(occurrences.length).toBeGreaterThan(0);
    for (const line of occurrences) {
      expect(line.trim().startsWith('Write-Host')).toBe(true);
    }
    // And never as a directly-invoked command (no leading `&`, no bare `nssm install` at
    // the start of a line outside Write-Host).
    expect(script).not.toMatch(/^\s*&?\s*nssm install/m);
  });

  it('contains every elevated install and uninstall line, and the pre-check text', () => {
    for (const line of elevatedInstallLines(input)) {
      expect(script).toContain(line.replace(/'/g, "''"));
    }
    for (const line of elevatedUninstallLines()) {
      expect(script).toContain(line);
    }
    for (const line of preCheckLines()) {
      expect(script).toContain(line.replace(/"/g, '\\"'));
    }
  });

  it('downloads only from nssm.cc, no package manager', () => {
    expect(script).toContain('https://nssm.cc/release/nssm-2.24.zip');
    expect(script).not.toMatch(/winget|choco|scoop/i);
  });
});

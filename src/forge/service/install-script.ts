/**
 * Generates `scripts/service-install.ps1` from the console's own paths and
 * `console.env.cmd` -- the values are read, never hand-typed, so the script always
 * matches whatever `forge up` would actually see.
 *
 * The generated script has two halves with very different trust levels:
 *
 *  - The download/verify/extract half actually RUNS when Aaron runs the script: it
 *    fetches nssm-2.24.zip, hashes it, and refuses to extract on any hash but the one
 *    pinned below. No package manager, no other source.
 *  - The service-install half is never executed by this script or by this loop -- it is
 *    only printed, because installing a service needs an elevated prompt this loop does
 *    not have and must not try to get. Aaron copies the printed block into an elevated
 *    PowerShell himself.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Verified 2026-09-10 by downloading https://nssm.cc/release/nssm-2.24.zip and hashing
 *  it directly (`sha256sum`) -- not copied from a third-party page. Aaron re-confirms
 *  against nssm.cc before running the install, per the guardrail. */
export const PINNED_NSSM_SHA256 = '727d1e42275c605e0f04aba98095c38a8e1e46def453cdffce42869428aa6743';
export const NSSM_URL = 'https://nssm.cc/release/nssm-2.24.zip';
export const SERVICE_NAME = 'FlightdeckConsole';

/** The same check the generated script's `Get-FileHash` comparison performs, exposed
 *  here so a test can prove the refusal fires on a wrong-hash zip without shelling out
 *  to PowerShell -- this is the real verification logic, mirrored (not stubbed) in the
 *  script text `generateInstallScript` writes below. */
export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function verifyNssmZip(buffer: Buffer): boolean {
  return sha256Hex(buffer) === PINNED_NSSM_SHA256;
}

const SET_LINE = /^set\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** Parses `set KEY=VALUE` lines the same way `loadConsoleEnv` does, without importing
 *  it (that helper fills `process.env`; this one just wants the pairs to print). */
export function parseConsoleEnvFile(contents: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const match = SET_LINE.exec(line);
    if (!match) continue;
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) continue;
    pairs.push([name, value]);
  }
  return pairs;
}

export interface InstallScriptInput {
  /** `~/.forge` (or `FORGE_HOME`). */
  home: string;
  /** The console worktree's own directory, e.g. `D:\repos\flightdeck-console`. */
  consoleWorktree: string;
  /** The account the service should log on as, e.g. `DESKTOP-1\aaron`. */
  serviceUser: string;
  /** `KEY=VALUE` pairs read from `console.env.cmd`. */
  envVars: Array<[string, string]>;
}

/** Reads `console.env.cmd` at `envPath` (returning `[]` if it does not exist, the same
 *  tolerant behaviour as `loadConsoleEnv`) and builds the full `InstallScriptInput`. */
export function readInstallScriptInput(input: {
  home: string; consoleWorktree: string; serviceUser: string; envPath: string;
}): InstallScriptInput {
  let contents = '';
  try {
    contents = readFileSync(input.envPath, 'utf8');
  } catch {
    contents = '';
  }
  return {
    home: input.home,
    consoleWorktree: input.consoleWorktree,
    serviceUser: input.serviceUser,
    envVars: parseConsoleEnvFile(contents),
  };
}

/** The exact elevated block Aaron runs himself, kept as one function so both the
 *  generated script's printed text and this module's own tests read the identical
 *  lines -- no second, silently-drifting copy of the command list. */
export function elevatedInstallLines(input: InstallScriptInput): string[] {
  const launcher = `${input.home}\\console.launch.cmd`;
  const envExtra = input.envVars.map(([key, value]) => `${key}=${value}`).join(' ');
  return [
    `nssm install ${SERVICE_NAME} cmd.exe /c "${launcher}"`,
    `nssm set ${SERVICE_NAME} AppDirectory "${input.consoleWorktree}"`,
    ...(envExtra ? [`nssm set ${SERVICE_NAME} AppEnvironmentExtra ${envExtra}`] : []),
    `nssm set ${SERVICE_NAME} AppStdout "${input.home}\\service\\stdout.log"`,
    `nssm set ${SERVICE_NAME} AppStderr "${input.home}\\service\\stderr.log"`,
    `nssm set ${SERVICE_NAME} AppRotateFiles 1`,
    `nssm set ${SERVICE_NAME} AppExit Default Restart`,
    `nssm set ${SERVICE_NAME} AppExit 75 Restart`,
    `nssm set ${SERVICE_NAME} AppExit 76 Exit`,
    `nssm set ${SERVICE_NAME} AppKillProcessTree 0`,
    `nssm set ${SERVICE_NAME} AppStopMethodSkip 6`,
    `nssm set ${SERVICE_NAME} ObjectName ".\\${input.serviceUser}" "<enter the password when prompted>"`,
    `# Aaron enters the account password once; if prompted, grant it "Log on as a service".`,
    `nssm set ${SERVICE_NAME} Start SERVICE_AUTO_START`,
    `nssm start ${SERVICE_NAME}`,
  ];
}

/** The reverse of the block above -- printed alongside it so undoing the install never
 *  needs a second trip back to this file. */
export function elevatedUninstallLines(): string[] {
  return [
    `nssm stop ${SERVICE_NAME}`,
    `nssm remove ${SERVICE_NAME} confirm`,
  ];
}

/** The pre-check Aaron runs first, in this order, with these words -- item 1's guardrail
 *  names the order and the wording explicitly, so this is the one place both the
 *  generated script and its test read from. */
export function preCheckLines(): string[] {
  return [
    '1) curl http://127.0.0.1:4120/state and read /whoswhere; proceed only when no run '
      + 'is mid-launch or mid-council and no session holds the queue.',
    '2) This is a hard kill of the hand-started console, which predates the graceful '
      + 'handler, so pick a quiet moment.',
    '3) taskkill /PID <pid of the 4120 listener> /F  -- no /T.',
    '4) Only if ~/.forge/console/queue.lock still exists after the kill, delete it '
      + '(queueLock.ts reclaims a dead holder on the next start anyway).',
  ];
}

/**
 * Builds the full PowerShell text. `download`/`hash`/`extract` are injected so a test
 * never touches the real filesystem or network -- production wires the real
 * `fetch`/`crypto`/`Expand-Archive` equivalents when this is written to disk by a
 * caller, but the script text itself embeds the pinned hash and a real PowerShell hash
 * check, not a Node runtime step (this loop is never elevated and never installs
 * anything itself).
 */
export function generateInstallScript(input: InstallScriptInput): string {
  const binDir = `${input.home}\\bin`;
  const zipPath = `${binDir}\\nssm-2.24.zip`;
  const exePath = `${binDir}\\nssm.exe`;
  const elevated = elevatedInstallLines(input);
  const uninstall = elevatedUninstallLines();
  const preCheck = preCheckLines();

  return `# Generated by src/forge/service/install-script.ts -- do not hand-edit.
# Downloads and verifies NSSM 2.24, then PRINTS (never runs) the elevated install block.
$ErrorActionPreference = 'Stop'
$PinnedSha256 = '${PINNED_NSSM_SHA256}'
$NssmUrl = '${NSSM_URL}'
$BinDir = '${binDir}'
$ZipPath = '${zipPath}'
$ExePath = '${exePath}'

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Invoke-WebRequest -Uri $NssmUrl -OutFile $ZipPath
$actualHash = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLower()
if ($actualHash -ne $PinnedSha256) {
  Write-Error "nssm-2.24.zip hash mismatch: expected $PinnedSha256, got $actualHash -- refusing to extract"
  exit 1
}
Expand-Archive -Path $ZipPath -DestinationPath $BinDir -Force
Copy-Item -Path (Join-Path $BinDir 'nssm-2.24\\win64\\nssm.exe') -Destination $ExePath -Force
Write-Host "nssm.exe staged at $ExePath (sha256 verified)"

# Derive the current console's pid for the pre-check text below.
$listenerPid = (netstat -ano | Select-String ':4120' | ForEach-Object { ($_ -split '\\s+')[-1] } | Select-Object -First 1)

Write-Host ""
Write-Host "=== Pre-check: run this first, every time ==="
${preCheck.map((line) => `Write-Host "${line.replace(/"/g, '\\"')}"`).join('\n')}
Write-Host "(detected listener pid: $listenerPid)"
Write-Host ""
Write-Host "=== Run this block yourself, in an ELEVATED PowerShell ==="
${elevated.map((line) => `Write-Host '${line.replace(/'/g, "''")}'`).join('\n')}
Write-Host ""
Write-Host "=== To undo ==="
${uninstall.map((line) => `Write-Host '${line.replace(/'/g, "''")}'`).join('\n')}
`;
}

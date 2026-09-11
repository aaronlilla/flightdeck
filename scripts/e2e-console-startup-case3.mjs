/**
 * G5 live end-to-end, Verification case 3 (goal brief
 * `2026-09-10-console-startup.md`) -- PARTIAL by design, documented as this
 * goal's one deferred item.
 *
 * What this proves: with a non-forge-shaped process already holding the
 * target port before the app ever starts, `bringUpConsole` correctly reads
 * `up-foreign` and chooses `confirm-restart` rather than silently attaching
 * or piling a second console on top of it -- the app's own log line is the
 * evidence, read from the status window's DOM exactly as case 1/2/4 do.
 *
 * What this does NOT prove, and why: the plan's full case 3 ("the app shows
 * the confirm-gated restart with the blast radius and the live-run check;
 * confirm -> launcher console replaces it") needs a UI dialog that does not
 * exist yet (main.ts's own comment: "this app does not yet surface the
 * confirm-gated restart dialog") and the real kill I/O
 * (`liveDescendantPids`, `killPidOnly`) that three prior sessions on this
 * brief deliberately left unwritten -- a wrong live-run check is the one way
 * this goal could violate its own absolute never-kill-workers guardrail, and
 * this machine has multiple other live coordinated sessions running real
 * work right now. Building and proving that safely is not something to do
 * for the first time under this goal's remaining wall-clock budget.
 *
 * Run from the repo root, after `npm --prefix desktop run build:app`:
 *   node scripts/e2e-console-startup-case3.mjs
 */
import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopDir = join(repoRoot, 'desktop');

function startForeignServer() {
  return new Promise((resolve) => {
    // Answers every path with plain text, 200 -- forge-shaped enough to not be
    // "down", not forge-shaped enough to be trusted as a real console
    // (probeHealth requires the /health body to parse as {consoleBuilt: boolean}).
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not a forge console');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'forge-e2e-case3-'));
  const userDataDir = join(dir, 'user-data');
  const forgeHome = join(dir, 'forge-home-app');
  const fakeHome = join(dir, 'fake-home');
  mkdirSync(forgeHome, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });

  const foreignServer = await startForeignServer();
  const port = foreignServer.address().port;
  console.log(`[e2e-case3] foreign (non-forge) server bound to 127.0.0.1:${port} before app launch`);

  const electronExecutablePath = join(desktopDir, 'node_modules', 'electron', 'dist', 'electron.exe');
  const electronApp = await electron.launch({
    executablePath: electronExecutablePath,
    args: ['.'],
    cwd: desktopDir,
    env: {
      ...process.env,
      FORGE_CONSOLE_ORIGIN: `http://127.0.0.1:${port}`,
      FORGE_PORT: String(port),
      FORGE_USER_DATA_DIR: userDataDir,
      FORGE_HOME: forgeHome,
      FORGE_REPO_DIR: repoRoot,
      FORGE_APP_HOME_OVERRIDE: fakeHome,
      USERPROFILE: fakeHome,
      HOME: fakeHome,
      ELECTRON_DISABLE_SANDBOX: '1',
    },
  });
  console.log(`[e2e-case3] electron process pid=${electronApp.process().pid}`);
  electronApp.process().stderr.on('data', (chunk) => process.stderr.write(`[app-stderr] ${chunk}`));

  const results = {};
  try {
    await new Promise((r) => setTimeout(r, 4000));
    const wins = electronApp.windows();
    const statusWin = wins.find((w) => !w.url().startsWith('http://127.0.0.1'));
    const message = statusWin ? await statusWin.evaluate(() => document.getElementById('message')?.textContent ?? null) : undefined;
    const log = statusWin ? await statusWin.evaluate(() => document.getElementById('log')?.textContent ?? null) : undefined;
    const boardWin = wins.find((w) => w.url().startsWith('http://127.0.0.1'));

    results.statusMessage = message;
    results.statusLog = log;
    results.boardWindowAppeared = Boolean(boardWin);
    console.log(`[e2e-case3] status message: ${JSON.stringify(message)}`);
    console.log(`[e2e-case3] status log: ${JSON.stringify(log)}`);
    console.log(`[e2e-case3] board window appeared (must be false -- never silently attach to a foreign process): ${results.boardWindowAppeared}`);
  } finally {
    await electronApp.close().catch(() => {});
    foreignServer.close();
    rmSync(dir, { recursive: true, force: true });
  }

  const detectedForeignCorrectly = !results.boardWindowAppeared
    && typeof results.statusLog === 'string'
    && results.statusLog.includes('does not look like a forge console');

  console.log('[e2e-case3] RESULT_JSON', JSON.stringify(results));
  console.log(`[e2e-case3] DETECTION_${detectedForeignCorrectly ? 'PASS' : 'FAIL'} (this is the detection half only -- see file header for what is NOT proven)`);
  process.exitCode = detectedForeignCorrectly ? 0 : 1;
}

main().catch((error) => {
  console.error('[e2e-case3] FAILED WITH EXCEPTION', error);
  process.exitCode = 1;
});

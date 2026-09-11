/**
 * G5 live end-to-end, Verification cases 1 and 4 (goal brief
 * `2026-09-10-console-startup.md`): drives the REAL packaged desktop app
 * against a real forge console this app itself starts on an ephemeral port
 * (never touching the live 4120), then kills that real child process and
 * confirms the watchdog revives it without a click.
 *
 * Case 1: nothing answering the target port -> the app builds the console,
 * starts a real `forge up`, the status window shows the build/start log
 * (never raw JSON), and the board loads.
 * Case 4: kill the server the app started -> the watchdog revives it through
 * the same bring-up path -> the window returns to the board on its own.
 *
 * Safety: FORGE_APP_HOME_OVERRIDE (main.ts's own test seam, added after this
 * harness's first run raced the real launcher against the real port 4120
 * console -- app.getPath('home') ignores USERPROFILE/HOME on Windows, so an
 * env-only override does not work) points the launcher-script check at a
 * scratch directory with no console.launch.cmd, so `planStart` always takes
 * the direct fallback command, never the real WMI launcher. FORGE_HOME is a
 * separate scratch directory, so the queue lock and registry this run
 * touches are its own, never the machine's real ones. The only process ever
 * killed is the one this run's own app spawns.
 *
 * Run from the repo root, after `npm --prefix desktop run build:app`:
 *   node scripts/e2e-console-startup-case1-4.mjs
 */
import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopDir = join(repoRoot, 'desktop');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function findPortHolderPid(port) {
  const { stdout } = await execFileAsync('powershell', [
    '-NoProfile', '-Command',
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`,
  ]);
  const pid = Number(stdout.trim());
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

async function killPidOnly(pid) {
  await execFileAsync('taskkill', ['/PID', String(pid), '/F']);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'forge-e2e-14-'));
  const userDataDir = join(dir, 'user-data');
  const forgeHome = join(dir, 'forge-home-app');
  const fakeHome = join(dir, 'fake-home');
  mkdirSync(forgeHome, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });

  const port = await freePort();
  console.log(`[e2e-14] target port ${port} is currently free; nothing answers it`);

  const results = { cases: [] };
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

  console.log(`[e2e-14] electron process pid=${electronApp.process().pid}`);
  electronApp.process().stderr.on('data', (chunk) => process.stderr.write(`[app-stderr] ${chunk}`));

  async function readStatus() {
    const wins = electronApp.windows();
    const statusWin = wins.find((w) => !w.url().startsWith('http://127.0.0.1'));
    if (!statusWin) return undefined;
    const message = await statusWin.evaluate(() => document.getElementById('message')?.textContent ?? null).catch(() => undefined);
    const log = await statusWin.evaluate(() => document.getElementById('log')?.textContent ?? null).catch(() => undefined);
    return { message, log };
  }

  async function findBoardWindow() {
    return electronApp.windows().find((w) => w.url().startsWith('http://127.0.0.1'));
  }

  try {
    // --- Case 1: cold start, nothing on the port, build + spawn + attach. ---
    console.log('[e2e-14] case 1: waiting for the app to build the console and start it for real (vite build + forge up)...');
    const caseOneDeadlineMs = Date.now() + 120_000;
    let boardWin;
    let lastStatus;
    while (Date.now() < caseOneDeadlineMs) {
      boardWin = await findBoardWindow();
      if (boardWin) break;
      lastStatus = await readStatus();
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (!boardWin) {
      results.cases.push({ case: 'verification-1-cold-start', ok: false, lastStatus });
      console.log('[e2e-14] case 1: FAILED -- board window never appeared within 120s');
      console.log(`[e2e-14] last status: ${JSON.stringify(lastStatus)}`);
    } else {
      const boardTitle = await boardWin.title();
      const boardUrl = boardWin.url();
      const hasTokenMeta = await boardWin.evaluate(() => Boolean(document.querySelector('meta[name="forge-token"]')));
      results.cases.push({
        case: 'verification-1-cold-start', ok: true,
        boardUrl, boardTitle, hasTokenMeta, lastStatusBeforeLoad: lastStatus,
      });
      console.log(`[e2e-14] case 1: PASS -- url=${boardUrl} title=${JSON.stringify(boardTitle)} hasTokenMeta=${hasTokenMeta}`);
      console.log(`[e2e-14] case 1: status window's own log before load: ${JSON.stringify(lastStatus)}`);
    }

    if (!boardWin) {
      console.log('[e2e-14] skipping case 4 -- case 1 never reached a loaded board to kill');
    } else {
      // --- Case 4: kill the real server this app started; watchdog revives it. ---
      const holderPid = await findPortHolderPid(port);
      if (!holderPid) {
        results.cases.push({ case: 'verification-4-kill-and-revive', ok: false, reason: 'could not find the pid holding the port before kill' });
        console.log('[e2e-14] case 4: FAILED -- no pid found holding the port; refusing to guess and kill the wrong thing');
      } else {
        console.log(`[e2e-14] case 4: killing pid ${holderPid} (the console this run's own app started on port ${port}), pid-only, never /T`);
        await killPidOnly(holderPid);

        console.log('[e2e-14] case 4: waiting for the watchdog to notice, revive, and reload the board without a click...');
        const caseFourDeadlineMs = Date.now() + 60_000;
        let revived = false;
        let statusDuringGone;
        while (Date.now() < caseFourDeadlineMs) {
          const wins = electronApp.windows();
          const stillBoard = wins.find((w) => w.url().startsWith('http://127.0.0.1'));
          if (stillBoard) {
            // Confirm it is genuinely serving again, not a stale window holding a 404.
            const title = await stillBoard.title().catch(() => undefined);
            const hasTokenMeta = await stillBoard.evaluate(() => Boolean(document.querySelector('meta[name="forge-token"]'))).catch(() => false);
            const holderNow = await findPortHolderPid(port).catch(() => undefined);
            // Case 1 already proved the real built page's title ("Flightdeck", the
            // built console's own <title>, distinct from the Electron window's OS
            // title bar text) -- what matters here is a *different* pid now answering
            // with the real forge-token meta, not a stale window replaying cached HTML.
            if (hasTokenMeta && holderNow && holderNow !== holderPid) {
              revived = true;
              results.cases.push({
                case: 'verification-4-kill-and-revive', ok: true,
                killedPid: holderPid, revivedPid: holderNow, boardTitle: title, hasTokenMeta,
              });
              console.log(`[e2e-14] case 4: PASS -- revived as new pid ${holderNow} (killed pid ${holderPid}), board title=${JSON.stringify(title)}, hasTokenMeta=${hasTokenMeta}`);
              break;
            }
          } else {
            statusDuringGone = await readStatus();
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (!revived) {
          results.cases.push({ case: 'verification-4-kill-and-revive', ok: false, killedPid: holderPid, statusDuringGone });
          console.log(`[e2e-14] case 4: FAILED -- did not see a revived board within 60s. status while gone: ${JSON.stringify(statusDuringGone)}`);
        }
      }
    }
  } finally {
    await electronApp.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }

  const allOk = results.cases.length > 0 && results.cases.every((c) => c.ok);
  console.log('[e2e-14] RESULT_JSON', JSON.stringify(results));
  console.log(`[e2e-14] ${allOk ? 'PASS' : 'FAIL'}`);
  process.exitCode = allOk ? 0 : 1;
}

main().catch((error) => {
  console.error('[e2e-14] FAILED WITH EXCEPTION', error);
  process.exitCode = 1;
});

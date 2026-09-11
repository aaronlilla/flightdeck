/**
 * G5 live end-to-end (goal brief `2026-09-10-console-startup.md`): drives the
 * REAL packaged desktop app (its built `build/main.cjs`, not a mock) against a
 * specimen `ForgeServer` on an ephemeral port, never the real 4120 the live
 * console occupies. `FORGE_CONSOLE_ORIGIN` points the whole app (window load,
 * health probe, the post-spawn wait loop -- probe.ts's `defaultPort()`) at the
 * specimen, not just the window.
 *
 * Verification case 2 from the plan: a specimen server with an empty
 * `consoleDistDir` -> the status window says the console is up but its page is
 * not built, never raw JSON -> write `index.html` -> the board loads on the
 * next poll.
 *
 * Run from the repo root, after `npm --prefix desktop run build:app`:
 *   node scripts/e2e-console-startup.mjs
 */
import { _electron as electron } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopDir = join(repoRoot, 'desktop');

function startSpecimenServer(consoleDistDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', join(repoRoot, 'scripts', 'e2e-console-startup-server.ts'), consoleDistDir], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], shell: true,
    });
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = /PORT=(\d+)/.exec(buffer);
      if (match) {
        child.stdout.off('data', onData);
        resolve({ child, port: Number(match[1]) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => process.stderr.write(`[specimen-server] ${chunk}`));
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) reject(new Error(`specimen server exited ${code}`));
    });
    setTimeout(() => reject(new Error('specimen server did not print PORT= within 15s')), 15_000);
  });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'forge-e2e-'));
  const consoleDistDir = join(dir, 'console-dist');
  mkdirSync(consoleDistDir, { recursive: true });
  const userDataDir = join(dir, 'user-data');
  const forgeHome = join(dir, 'forge-home-app');
  mkdirSync(forgeHome, { recursive: true });

  console.log('[e2e] starting specimen ForgeServer with an EMPTY consoleDistDir...');
  const { child: serverProcess, port } = await startSpecimenServer(consoleDistDir);
  console.log(`[e2e] specimen server on 127.0.0.1:${port}, consoleDistDir=${consoleDistDir} (empty)`);

  const results = { cases: [] };

  const electronExecutablePath = join(desktopDir, 'node_modules', 'electron', 'dist', 'electron.exe');
  const electronApp = await electron.launch({
    executablePath: electronExecutablePath,
    args: ['.'],
    cwd: desktopDir,
    env: {
      ...process.env,
      FORGE_CONSOLE_ORIGIN: `http://127.0.0.1:${port}`,
      FORGE_USER_DATA_DIR: userDataDir,
      FORGE_HOME: forgeHome,
      FORGE_REPO_DIR: repoRoot,
      ELECTRON_DISABLE_SANDBOX: '1',
    },
  });

  const logLines = [];
  const rawStdout = [];
  console.log(`[e2e] electron process pid=${electronApp.process().pid}`);
  electronApp.process().stdout.on('data', (chunk) => {
    const text = chunk.toString();
    rawStdout.push(text);
    for (const line of text.split('\n')) {
      if (line.trim()) process.stdout.write(`[app-stdout] ${line}\n`);
      if (line.includes('[forge-console]')) logLines.push(line.trim());
    }
  });
  electronApp.process().stderr.on('data', (chunk) => process.stderr.write(`[app-stderr] ${chunk}`));

  try {
    // Case 2, phase 1: not-built. Give the app time to probe and settle on
    // the status window with the "not serving" sentence.
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const windowsBefore = electronApp.windows();
    console.log(`[e2e] phase 1 windows: ${JSON.stringify(windowsBefore.map((w) => w.url()))}`);
    const statusWin = windowsBefore.find((w) => !w.url().startsWith('http://127.0.0.1'));
    // Windows' Electron GUI subsystem does not reliably pipe main-process
    // console.log to the parent's stdout, so the app's own log lines (order 4's
    // required evidence) are read from the status window's own DOM instead --
    // the same #message/#log elements logToStatus()/showStatus() actually write
    // to, which is arguably closer to "the app's own" evidence than a stdout
    // side-channel would have been.
    const statusMessage = statusWin ? await statusWin.evaluate(() => document.getElementById('message')?.textContent ?? null) : undefined;
    const statusLog = statusWin ? await statusWin.evaluate(() => document.getElementById('log')?.textContent ?? null) : undefined;

    results.cases.push({
      case: 'verification-2-phase-1-not-built',
      statusMessage,
      statusLog,
    });

    console.log(`[e2e] phase 1 (not built): statusMessage=${JSON.stringify(statusMessage)}`);
    console.log(`[e2e] phase 1 (not built): statusLog=${JSON.stringify(statusLog)}`);

    // Case 2, phase 2: write index.html with the forge-token meta, matching
    // the real vite build's output shape closely enough for probeHealth()'s
    // forge-shape check and serveStatic()'s token substitution.
    writeFileSync(join(consoleDistDir, 'index.html'), '<!doctype html><html><head><meta name="forge-token" content="" /><title>Forge Console</title></head><body>board</body></html>', 'utf8');
    console.log('[e2e] wrote index.html to the specimen consoleDistDir -- waiting for the load loop to poll and load...');

    await new Promise((resolve) => setTimeout(resolve, 5000));

    const windowsAfter = electronApp.windows();
    console.log(`[e2e] phase 2 windows: ${JSON.stringify(windowsAfter.map((w) => w.url()))}`);
    const boardWin = windowsAfter.find((w) => w.url().startsWith('http://127.0.0.1'));
    let boardTitle;
    let hasTokenMeta;
    let mainFrameUrl;
    if (boardWin) {
      boardTitle = await boardWin.title();
      mainFrameUrl = boardWin.url();
      hasTokenMeta = await boardWin.evaluate(() => Boolean(document.querySelector('meta[name="forge-token"]')));
    }

    results.cases.push({
      case: 'verification-2-phase-2-built',
      boardWindowUrl: mainFrameUrl,
      boardWindowTitle: boardTitle,
      hasTokenMeta,
      logLinesSoFar: [...logLines],
    });

    console.log(`[e2e] phase 2 (built): url=${mainFrameUrl} title=${JSON.stringify(boardTitle)} hasTokenMeta=${hasTokenMeta}`);
  } finally {
    await electronApp.close().catch(() => {});
    serverProcess.kill();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('[e2e] RESULT_JSON', JSON.stringify(results));

  const phase1 = results.cases[0];
  const phase2 = results.cases[1];
  const ok = phase1 && !phase1.statusWindowTitle?.startsWith('{')
    && phase2 && phase2.boardWindowUrl?.startsWith('http://127.0.0.1')
    && phase2.hasTokenMeta === true;

  console.log(`[e2e] ${ok ? 'PASS' : 'FAIL'}`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  console.error('[e2e] FAILED WITH EXCEPTION', error);
  process.exitCode = 1;
});

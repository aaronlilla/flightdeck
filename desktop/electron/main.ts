import {
  app, BrowserWindow, Menu, Tray, shell, dialog, ipcMain,
} from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { get as httpGet, type IncomingMessage } from 'node:http';

import { locateCheckout, type LocateFs } from './locate-checkout';
import {
  mergeForgeEnv, readSettings, updateSettings, type SettingsFs, type WindowBounds,
} from './settings';
import { bringUpConsole, type Spawned, type SupervisorDeps } from './console-supervisor';
import { createConsoleWatchdog, type ConsoleWatchdog, type ReviveResult } from './console-watchdog';
import { probeConsole, probeHealth, waitUntilReachable } from './probe';
import { createLoadLoop, type LoadLoop } from './load-loop';
import { readQueueLockOwner } from './queue-lock';
import { readCheckoutFile } from './checkout-file';
import { decideQuitAction } from './quit-rule';
import { hasLiveRun } from './fleet-state';
import { readGitHead } from './git-head';
import { consoleLabel } from './labels';
import { queueIsOn } from './queue-state';
import { WINDOW_OPTIONS, STATUS_WINDOW_OPTIONS } from './window-options';
import { statusPageHtml } from './status-page';
import { settingsPageHtml } from './settings-page';
import { appIcon, trayIcon } from './brand';
import { consoleOrigin } from './console-origin';

const CONSOLE_ORIGIN = consoleOrigin(process.env);

const fsAdapter: LocateFs & SettingsFs = {
  existsSync,
  readFileSync: (p) => readFileSync(p, 'utf8'),
  writeFileSync: (p, data) => writeFileSync(p, data, 'utf8'),
  mkdirSync: (p) => mkdirSync(p, { recursive: true }),
};

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

/** `app.getPath('home')` reads the OS user-profile folder directly and does not
 *  follow a `USERPROFILE`/`HOME` env override on Windows -- an e2e harness that
 *  wants to test the fresh-start path without ever reaching the real
 *  `~/.forge/console.launch.cmd` (found live, 2026-09-11: an e2e run without this
 *  seam raced the real WMI launcher against the real port 4120 console) needs its
 *  own seam. `FORGE_APP_HOME_OVERRIDE` is that seam -- unset in every normal run. */
function appHomeDir(): string {
  return process.env['FORGE_APP_HOME_OVERRIDE'] ?? app.getPath('home');
}

function fetchState(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = httpGet(
      { host: '127.0.0.1', port: 4120, path: '/state', timeout: 2000 },
      (response: IncomingMessage) => {
        let body = '';
        response.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('timeout', () => { request.destroy(); reject(new Error('/state timed out')); });
    request.on('error', reject);
  });
}

function spawnChild(command: string, args: string[], cwd: string, env: Record<string, string> = {}): Spawned {
  // G5 live e2e finding, 2026-09-11: spawning a `.cmd`/`.bat` command (buildStartCommand's
  // `npm.cmd run forge -- up` fallback, taken whenever no launcher script is installed)
  // without `shell: true` throws a synchronous `spawn EINVAL` on Windows -- uncaught by
  // bringUpConsole's caller, it silently stranded the status window on "Bringing up the
  // console..." forever. Only found by actually spawning a real child process end to end;
  // no unit test in this repo drives node:child_process's own OS-level spawn behavior.
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const child = nodeSpawn(command, args, {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, shell,
  });
  return {
    pid: child.pid,
    onExit: (handler) => child.on('exit', (code) => handler(code)),
    onOutput: (handler) => {
      child.stdout?.on('data', (chunk: Buffer) => handler(chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => handler(chunk.toString()));
    },
    // Code-review finding, 2026-09-11: when `shell` wraps the command in
    // cmd.exe (the .cmd/.bat case above), child.kill() only signals the
    // cmd.exe wrapper -- the actual npm/node process it launched keeps
    // running, orphaned and still bound to the port, blocking every later
    // launch attempt. This is a tree-kill of a process THIS app itself
    // spawned (the console-supervisor start/timeout path), not the
    // confirm-restart's pid-only-never-/T rule, which governs killing a
    // possibly-foreign process this app never started.
    kill: () => {
      if (shell && child.pid !== undefined) {
        try {
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
          // Already exited, or taskkill itself failed -- child.kill() below
          // is the same best-effort fallback the non-shell path already is.
          child.kill();
        }
      } else {
        child.kill();
      }
    },
  };
}

/**
 * Item 4: runs a `BuildStep` (the vite console build) to completion, capturing
 * combined stdout/stderr for the failure message. `ELECTRON_RUN_AS_NODE` is
 * added the same way `buildStartCommand` adds it when the command is this
 * app's own executable, so the build step works whether `nodeExecPath` came
 * out packaged (this app's own exe) or unpackaged (a real Node binary, which
 * ignores the variable).
 */
/** Item 3: a plain `process.kill(pid, 0)` signal probe, the same technique
 *  `src/forge/registry.ts`'s `processAlive` uses server-side -- signal 0 sends
 *  nothing, it only asks whether the pid exists and this process may signal it. */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runBuildStep(step: { command: string; args: string[]; cwd: string }): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = nodeSpawn(step.command, step.args, {
      cwd: step.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('exit', (code) => resolve({ ok: code === 0, output }));
    child.on('error', (error) => resolve({ ok: false, output: output + String(error) }));
  });
}

let mainWindow: BrowserWindow | undefined;
let statusWindow: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let startedByThisApp = false;
let spawnedProcess: Spawned | undefined;
let currentLabel = 'Forge';
let resolvedCheckoutDir: string | undefined;
let watchdog: ConsoleWatchdog | undefined;
let loadLoop: LoadLoop | undefined;

function showStatus(text: string): void {
  statusWindow?.webContents.send('status', text);
}

function logToStatus(line: string): void {
  statusWindow?.webContents.send('log', line);
  // G5, 2026-09-10: also on stdout, prefixed so it is grep-able, so a live
  // end-to-end test can read the app's own health/action log lines without a
  // renderer-side IPC listener -- the evidence the goal brief requires
  // ("the app's own log lines naming the health value and the action taken").
  // eslint-disable-next-line no-console
  console.log(`[forge-console] ${line}`);
}

function createStatusWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...STATUS_WINDOW_OPTIONS,
    icon: appIcon(),
    title: 'Forge — starting…',
    webPreferences: {
      ...STATUS_WINDOW_OPTIONS.webPreferences,
      preload: join(__dirname, 'status-preload.cjs'),
    },
  });
  win.setMenu(null);
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(statusPageHtml())}`);
  win.once('ready-to-show', () => win.show());
  return win;
}

/**
 * C.3: a plain key/value form over `settings.json`'s own `forgeEnv`, the same small
 * data-URL window `createStatusWindow` already uses. `ipcMain.once` mirrors
 * `resolveCheckoutDir`'s own one-shot `pick-folder` handler below -- a fresh listener
 * per open, since a closed window's stale one must never fire against a window that no
 * longer exists.
 */
function createSettingsWindow(): BrowserWindow {
  const current = readSettings(fsAdapter, settingsPath()).forgeEnv ?? {};
  const win = new BrowserWindow({
    ...STATUS_WINDOW_OPTIONS,
    icon: appIcon(),
    title: 'Forge — environment',
    webPreferences: {
      ...STATUS_WINDOW_OPTIONS.webPreferences,
      preload: join(__dirname, 'status-preload.cjs'),
    },
  });
  win.setMenu(null);
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(settingsPageHtml(current))}`);
  win.once('ready-to-show', () => win.show());

  const onSave = (_event: unknown, entries: Record<string, string>): void => {
    updateSettings(fsAdapter, settingsPath(), { forgeEnv: entries });
    void dialog.showMessageBox(win, {
      type: 'info',
      message: 'Saved. Restart the server (Forge menu) for the new environment to take effect.',
    });
  };
  ipcMain.on('save-forge-env', onSave);
  win.on('closed', () => {
    ipcMain.removeListener('save-forge-env', onSave);
    if (settingsWindow === win) settingsWindow = undefined;
  });
  return win;
}

function openSettingsWindow(): void {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = createSettingsWindow();
}

function createMainWindow(): BrowserWindow {
  const settings = readSettings(fsAdapter, settingsPath());
  const bounds = settings.windowBounds;
  const win = new BrowserWindow({
    ...WINDOW_OPTIONS,
    ...(bounds ?? {}),
    icon: appIcon(),
    title: currentLabel,
    webPreferences: { ...WINDOW_OPTIONS.webPreferences },
  });
  win.setMenu(null);
  win.once('ready-to-show', () => win.show());

  // The console's own page sets a document title, which Electron applies to
  // the window by default. This window's title carries the head-and-mode
  // label instead, so that overwrite is refused.
  win.on('page-title-updated', (event) => event.preventDefault());

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${CONSOLE_ORIGIN}/`) && url !== CONSOLE_ORIGIN) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const saveBounds = (): void => {
    const size = win.getSize();
    const position = win.getPosition();
    const value: WindowBounds = {
      width: size[0] ?? WINDOW_OPTIONS.width,
      height: size[1] ?? WINDOW_OPTIONS.height,
      x: position[0],
      y: position[1],
    };
    updateSettings(fsAdapter, settingsPath(), { windowBounds: value });
  };
  win.on('close', (event) => {
    if (win.isDestroyed()) return;
    saveBounds();
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  return win;
}

/**
 * Binds a real `load-loop.ts` state machine to `win`'s actual navigation
 * events: the main-frame response status via `onHeadersReceived` (never a
 * sub-resource -- only `resourceType === 'mainFrame'` reaches the loop) and
 * `did-fail-load`. `probeHealth()` is the loop's probe, so it never calls
 * `loadURL` until `/health` (or the older-server fallback) reads healthy.
 */
function wireLoadLoop(win: BrowserWindow): LoadLoop {
  const loop = createLoadLoop({
    probe: () => probeHealth(),
    loadURL: () => win.loadURL(`${CONSOLE_ORIGIN}/`),
    onStatus: (text) => {
      if (!statusWindow) statusWindow = createStatusWindow();
      showStatus(text);
    },
    onLoaded: () => {
      statusWindow?.close();
      statusWindow = undefined;
    },
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  });

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType === 'mainFrame' && details.url.startsWith(CONSOLE_ORIGIN)) {
      loop.reportMainFrameStatus(details.statusCode);
    }
    callback({});
  });
  win.webContents.on('did-fail-load', (_event, _errorCode, _description, _validatedURL, isMainFrame) => {
    if (isMainFrame) loop.reportFailLoad();
  });

  return loop;
}

function focusExisting(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

async function resolveCheckoutDir(): Promise<string | undefined> {
  const settings = readSettings(fsAdapter, settingsPath());
  const installDir = dirname(app.getPath('exe'));
  const found = locateCheckout(fsAdapter, {
    env: { FORGE_REPO_DIR: process.env['FORGE_REPO_DIR'] },
    rememberedCheckoutDir: settings.checkoutDir,
    // Code-review finding, 2026-09-10: this call never read the canonical checkout
    // file at all -- item 4's "one checkout every launcher reads" reached dev.cjs
    // and dev-hidden.vbs but not the packaged app itself, the one users actually run.
    checkoutFileDir: readCheckoutFile(fsAdapter, join, appHomeDir()),
    installDir,
    join,
  });
  if (found) return found.dir;

  statusWindow?.webContents.send('need-folder');
  showStatus('Could not find a Forge checkout. Pick the repository folder to continue.');
  return new Promise((resolve) => {
    ipcMain.once('pick-folder', async () => {
      if (!statusWindow) return resolve(undefined);
      const result = await dialog.showOpenDialog(statusWindow, { properties: ['openDirectory'] });
      if (result.canceled || result.filePaths.length === 0) return resolve(undefined);
      const picked = result.filePaths[0]!;
      updateSettings(fsAdapter, settingsPath(), { checkoutDir: picked });
      resolve(picked);
    });
  });
}

function git(): { run(args: string[], cwd: string): string } {
  return { run: (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }) };
}

/** `wait`/`show-no-console` are transient by nature (a launcher mid-start, a
 *  build not finished yet) -- e2e finding, 2026-09-10: the first version of
 *  this handling dead-ended on these outcomes until a manual Retry click,
 *  which fails the plan's own Verification case 2 ("the board loads on the
 *  next poll", no click involved). Retries `bootstrap()` on a short interval
 *  instead. Cleared whenever `bootstrap()` reaches any other outcome, so it
 *  never keeps firing once a console actually comes up (or the user clicks
 *  Retry themselves, which calls `bootstrap()` directly). */
let bootstrapRetryTimer: NodeJS.Timeout | undefined;
const BOOTSTRAP_RETRY_MS = 3_000;

function clearBootstrapRetry(): void {
  if (bootstrapRetryTimer !== undefined) {
    clearTimeout(bootstrapRetryTimer);
    bootstrapRetryTimer = undefined;
  }
}

function scheduleBootstrapRetry(): void {
  clearBootstrapRetry();
  bootstrapRetryTimer = setTimeout(() => { void bootstrap(); }, BOOTSTRAP_RETRY_MS);
}

async function bootstrap(): Promise<void> {
  clearBootstrapRetry();
  // Reuse the existing status window across retries rather than stacking a
  // fresh one on every auto-retry.
  if (!statusWindow || statusWindow.isDestroyed()) statusWindow = createStatusWindow();
  showStatus('Looking for a running console on 127.0.0.1:4120…');

  const checkoutDir = await resolveCheckoutDir();
  if (!checkoutDir) {
    showStatus('No checkout selected. Set FORGE_REPO_DIR and restart, or pick a folder above.');
    return;
  }

  // C.3: settings.json's own forgeEnv (FORGE_QUEUE, FORGE_JIRA_*, FORGE_REPO_*,
  // FORGE_PORT, ...) merged over this process's own environment for the child the
  // supervisor spawns -- a setting always wins, since a shortcut launch has no other
  // way to carry one. Read fresh here rather than cached, so a save from the Settings
  // window before a restart is picked up without relaunching the whole app.
  const forgeEnv = readSettings(fsAdapter, settingsPath()).forgeEnv;
  const mergedEnv = mergeForgeEnv(process.env, forgeEnv);
  const queueOn = queueIsOn(mergedEnv);
  statusWindow?.webContents.send('queue-state', queueOn);

  resolvedCheckoutDir = checkoutDir;
  const deps = buildSupervisorDeps(forgeEnv);

  showStatus('Bringing up the console…');
  // G3 finding, 2026-09-10 (accepted, not fixed at the time): bootstrap() had no
  // try/catch around this call, unlike the watchdog's revive path. Confirmed as real
  // harm by G5's own live e2e, 2026-09-11 (a real spawn EINVAL on this exact call
  // stranded the status window on "Bringing up the console..." forever, with only an
  // unhandled-rejection warning on stderr no one watching the window would ever see).
  // Auto-retries rather than dead-ending, matching 'wait'/'show-no-console' below.
  let outcome: Awaited<ReturnType<typeof bringUpConsole>>;
  try {
    outcome = await bringUpConsole(checkoutDir, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showStatus(`bringing up the console failed unexpectedly: ${message}`);
    statusWindow?.webContents.send('revive-failed');
    scheduleBootstrapRetry();
    return;
  }

  if (outcome.mode === 'start-failed') {
    showStatus(outcome.reason);
    statusWindow?.webContents.send('revive-failed');
    return;
  }
  if (outcome.mode === 'wait') {
    // A console (someone else's launch, most likely the launcher itself) is already
    // starting or running under the queue lock -- never launch a second one into it.
    // Auto-retries (e2e finding, 2026-09-10): a lock owner mid-launch resolves itself
    // in seconds, and the plan's Verification cases never involve a click.
    showStatus(`a console (pid ${outcome.ownerPid}) is already starting or running; waiting for it to become healthy…`);
    statusWindow?.webContents.send('revive-failed');
    scheduleBootstrapRetry();
    return;
  }
  if (outcome.mode === 'show-no-console') {
    // Same auto-retry reasoning as 'wait': the console answering with no page
    // built yet is exactly the transient state Verification case 2 exercises
    // (write index.html moments later, expect the board on the next poll).
    showStatus('the console on 127.0.0.1:4120 is running but has not built its page yet…');
    statusWindow?.webContents.send('revive-failed');
    scheduleBootstrapRetry();
    return;
  }
  if (outcome.mode === 'confirm-restart') {
    // Proposal only: this app does not yet surface the confirm-gated restart dialog
    // (that UI is not built), so the honest status here is "detected, not offered" --
    // never a silent attach to a process this server-shape check does not trust.
    showStatus('something on 127.0.0.1:4120 does not look like a forge console. A confirm-gated restart is not yet offered from this screen.');
    statusWindow?.webContents.send('revive-failed');
    return;
  }

  startedByThisApp = outcome.mode === 'start';
  if (startedByThisApp) spawnedProcess = (outcome as { process: Spawned }).process;

  const head = startedByThisApp ? readGitHead(git(), checkoutDir) : undefined;
  currentLabel = consoleLabel(startedByThisApp ? 'started' : 'attached', head);

  showStatus('Loading the board…');
  mainWindow = createMainWindow();
  mainWindow.setTitle(currentLabel);
  tray?.setToolTip(currentLabel);

  loadLoop?.stop();
  loadLoop = wireLoadLoop(mainWindow);
  loadLoop.start();

  watchdog?.stop();
  watchdog = createConsoleWatchdog(buildWatchdogDeps());
  watchdog.start();
}

/** The same probe/spawn/launcher plumbing `bootstrap()` hands `bringUpConsole`,
 *  built as its own function so the watchdog's revive can run the identical
 *  bring-up attempt later. */
function buildSupervisorDeps(forgeEnv: Record<string, string> | undefined): SupervisorDeps {
  const homeDir = appHomeDir();
  // Code-review finding, 2026-09-10: the queue lock the server actually writes lives
  // under FORGE_HOME when it is set (src/forge/paths.ts's forgeHome()), not always
  // <home>/.forge -- reading the wrong directory silently disables the wait/attach
  // check this app just gained, with no error at all.
  const forgeHomeDir = process.env['FORGE_HOME'] ?? join(homeDir, '.forge');
  return {
    probe: probeConsole,
    probeHealth: () => probeHealth(),
    queueLockOwner: () => readQueueLockOwner(fsAdapter, join, forgeHomeDir, pidIsAlive),
    spawn: (command, args, cwd, env) => spawnChild(command, args, cwd, { ...env, ...forgeEnv }),
    fs: fsAdapter,
    join,
    nodeExecPath: process.execPath,
    homeDir,
    runBuild: runBuildStep,
    waitUntilReachable,
    onLog: logToStatus,
  };
}

/** Runs the same bring-up attempt bootstrap used, for the watchdog to call
 *  once the console has been declared gone. On success it also reloads the
 *  board window and puts the head-and-mode label back on the title bar. */
async function reviveConsole(): Promise<ReviveResult> {
  if (!resolvedCheckoutDir) {
    return { ok: false, reason: 'no Forge checkout is known, so the console cannot be brought back on its own' };
  }
  const forgeEnv = readSettings(fsAdapter, settingsPath()).forgeEnv;
  const deps = buildSupervisorDeps(forgeEnv);
  const outcome = await bringUpConsole(resolvedCheckoutDir, deps);
  if (outcome.mode === 'start-failed') {
    return { ok: false, reason: outcome.reason };
  }
  if (outcome.mode === 'wait') {
    return { ok: false, reason: `a console (pid ${outcome.ownerPid}) is already starting or running; waiting for it to become healthy` };
  }
  if (outcome.mode === 'show-no-console') {
    return { ok: false, reason: 'the console is running but has not built its page yet' };
  }
  if (outcome.mode === 'confirm-restart') {
    return { ok: false, reason: 'something on 127.0.0.1:4120 does not look like a forge console; a confirm-gated restart is not yet offered from this screen' };
  }

  startedByThisApp = outcome.mode === 'start';
  spawnedProcess = startedByThisApp ? (outcome as { process: Spawned }).process : undefined;

  const head = startedByThisApp ? readGitHead(git(), resolvedCheckoutDir) : undefined;
  currentLabel = consoleLabel(startedByThisApp ? 'started' : 'attached', head);
  tray?.setToolTip(currentLabel);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(currentLabel);
    // Route back through the load loop rather than a raw loadURL: the same
    // health-poll-then-load discipline applies to a watchdog revive as to
    // the first load, so a revive that races a still-not-quite-healthy
    // console still ends on the board, never a stranded 404.
    if (!loadLoop) loadLoop = wireLoadLoop(mainWindow);
    loadLoop.restart();
  }
  return { ok: true };
}

function buildWatchdogDeps() {
  return {
    probe: () => probeHealth(),
    revive: reviveConsole,
    onLog: logToStatus,
    onGone: (label: string) => {
      if (!statusWindow) statusWindow = createStatusWindow();
      showStatus(`the console went away at ${label}; bringing it back`);
    },
    onRevived: () => {
      statusWindow?.close();
      statusWindow = undefined;
    },
    onFailed: (reason: string) => {
      showStatus(reason);
      statusWindow?.webContents.send('revive-failed');
    },
    now: () => Date.now(),
    setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function buildTray(): Tray {
  const trayInstance = new Tray(trayIcon());
  trayInstance.setToolTip('Forge');
  trayInstance.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: focusExisting },
    { label: 'Open in browser', click: () => void shell.openExternal(`${CONSOLE_ORIGIN}/`) },
    { label: 'Settings…', click: openSettingsWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => void handleQuitRequest() },
  ]));
  trayInstance.on('click', focusExisting);
  return trayInstance;
}

function buildAppMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Forge',
      submenu: [
        { label: 'Reload', click: () => mainWindow?.reload() },
        { label: 'Toggle Developer Tools', click: () => mainWindow?.webContents.toggleDevTools() },
        {
          label: 'Open Forge home folder',
          click: () => void shell.openPath(process.env['FORGE_HOME'] ?? join(app.getPath('home'), '.forge')),
        },
        { label: 'Restart the server', click: () => void restartServer() },
        { label: 'Settings…', click: openSettingsWindow },
        { type: 'separator' },
        { label: 'Quit', click: () => void handleQuitRequest() },
      ],
    },
  ]));
}

async function restartServer(): Promise<void> {
  if (!startedByThisApp || !spawnedProcess) {
    void dialog.showMessageBox({
      type: 'info',
      message: 'This app is attached to a console it did not start, so it will not restart it.',
    });
    return;
  }
  spawnedProcess.kill();
  spawnedProcess = undefined;
  startedByThisApp = false;
  await bootstrap();
}

let isQuitting = false;

async function handleQuitRequest(): Promise<void> {
  let liveRun = false;
  try {
    const state = await fetchState();
    liveRun = hasLiveRun(state);
  } catch {
    // The console is unreachable; treat that as nothing live rather than
    // blocking a quit on a server that has already gone away.
    liveRun = false;
  }

  const action = decideQuitAction(startedByThisApp, liveRun);
  if (action.kind === 'leave-server-and-quit' && action.reason === 'run-live') {
    await dialog.showMessageBox({
      type: 'warning',
      message: 'A run is live. The console will keep running in the background so nothing gets killed.',
    });
  }
  if (action.kind === 'stop-server-and-quit') {
    spawnedProcess?.kill();
  }
  isQuitting = true;
  app.quit();
}

// A separate userData dir gives a dev copy its own single-instance lock and its
// own settings, so it runs beside the installed app and attaches to the same
// console. Has to land before the lock is requested, which lives under userData.
const userDataDir = process.env['FORGE_USER_DATA_DIR']?.trim();
if (userDataDir) app.setPath('userData', userDataDir);

// Matches `appId` in electron-builder.yml, so the taskbar files the window under
// the same identity as the installed shortcut and shows the shortcut's icon
// when pinned.
if (process.platform === 'win32') app.setAppUserModelId('com.forge.console');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    focusExisting();
    // 2026-09-10 18:45 finding: a stale window still holding a 404 body from
    // an earlier stale-dist episode never recovers on its own -- the window
    // stays open, single-instance hands this click to focusExisting, and
    // nothing re-checks what is actually on screen. Re-running the loop means
    // a click on the shortcut always re-polls health and reloads if the page
    // is not currently up-healthy, instead of only focusing whatever is there.
    loadLoop?.restart();
  });

  // The Retry button on the status window: while the watchdog is running,
  // this asks it to try again right now (bypassing its backoff); before the
  // board has ever loaded, there is no watchdog yet, so it re-runs bootstrap.
  ipcMain.on('retry-console', () => {
    if (watchdog) {
      watchdog.retryNow();
    } else {
      void bootstrap();
    }
  });

  app.whenReady().then(() => {
    buildAppMenu();
    tray = buildTray();
    void bootstrap();
  }).catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    // Tray-resident: closing the window never quits the app on its own.
  });

  app.on('before-quit', () => {
    isQuitting = true;
    watchdog?.stop();
    clearBootstrapRetry();
  });
}

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
import { probeConsole, waitUntilReachable } from './probe';
import { decideQuitAction } from './quit-rule';
import { hasLiveRun } from './fleet-state';
import { readGitHead } from './git-head';
import { consoleLabel } from './labels';
import { queueIsOn } from './queue-state';
import { accountsLine } from './accounts-line';
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

/** `GET /accounts` with the console's own server token, capped at two seconds; any
 *  failure becomes one honest status line rather than a missing one. */
async function readAccountsLine(): Promise<string> {
  const forgeHomeDir = process.env['FORGE_HOME'] ?? join(app.getPath('home'), '.forge');
  const tokenPath = join(forgeHomeDir, 'server-token');
  let token = '';
  try {
    token = readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return `Accounts: not read (no server token at ${tokenPath}).`;
  }
  return new Promise((resolve) => {
    const request = httpGet(
      { host: '127.0.0.1', port: 4120, path: '/accounts', timeout: 2000, headers: { 'x-forge-token': token } },
      (response: IncomingMessage) => {
        let body = '';
        response.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        response.on('end', () => {
          if (response.statusCode !== 200) { resolve(`Accounts: not read (/accounts answered ${response.statusCode}).`); return; }
          try {
            resolve(accountsLine(JSON.parse(body)));
          } catch (error) {
            resolve(`Accounts: not read (${error instanceof Error ? error.message : String(error)}).`);
          }
        });
      },
    );
    request.on('timeout', () => { request.destroy(); resolve('Accounts: not read (/accounts timed out).'); });
    request.on('error', (error) => resolve(`Accounts: not read (${error.message}).`));
  });
}

function spawnChild(command: string, args: string[], cwd: string, env: Record<string, string> = {}): Spawned {
  const child = nodeSpawn(command, args, {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  return {
    pid: child.pid,
    onExit: (handler) => child.on('exit', (code) => handler(code)),
    onOutput: (handler) => {
      child.stdout?.on('data', (chunk: Buffer) => handler(chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => handler(chunk.toString()));
    },
    kill: () => child.kill(),
  };
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

function showStatus(text: string): void {
  statusWindow?.webContents.send('status', text);
}

function logToStatus(line: string): void {
  statusWindow?.webContents.send('log', line);
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

async function bootstrap(): Promise<void> {
  statusWindow = createStatusWindow();
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
  const outcome = await bringUpConsole(checkoutDir, deps);

  if (outcome.mode === 'start-failed') {
    showStatus(outcome.reason);
    statusWindow?.webContents.send('revive-failed');
    return;
  }

  startedByThisApp = outcome.mode === 'start';
  if (startedByThisApp) spawnedProcess = (outcome as { process: Spawned }).process;

  const head = startedByThisApp ? readGitHead(git(), checkoutDir) : undefined;
  currentLabel = consoleLabel(startedByThisApp ? 'started' : 'attached', head);

  logToStatus(await readAccountsLine());

  showStatus('Loading the board…');
  mainWindow = createMainWindow();
  mainWindow.setTitle(currentLabel);
  await mainWindow.loadURL(`${CONSOLE_ORIGIN}/`);

  tray?.setToolTip(currentLabel);
  statusWindow?.close();
  statusWindow = undefined;

  watchdog?.stop();
  watchdog = createConsoleWatchdog(buildWatchdogDeps());
  watchdog.start();
}

/** The same probe/spawn/launcher plumbing `bootstrap()` hands `bringUpConsole`,
 *  built as its own function so the watchdog's revive can run the identical
 *  bring-up attempt later. */
function buildSupervisorDeps(forgeEnv: Record<string, string> | undefined): SupervisorDeps {
  return {
    probe: probeConsole,
    spawn: (command, args, cwd, env) => spawnChild(command, args, cwd, { ...env, ...forgeEnv }),
    fs: fsAdapter,
    join,
    nodeExecPath: process.execPath,
    homeDir: app.getPath('home'),
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

  startedByThisApp = outcome.mode === 'start';
  spawnedProcess = startedByThisApp ? (outcome as { process: Spawned }).process : undefined;

  const head = startedByThisApp ? readGitHead(git(), resolvedCheckoutDir) : undefined;
  currentLabel = consoleLabel(startedByThisApp ? 'started' : 'attached', head);
  tray?.setToolTip(currentLabel);

  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(`${CONSOLE_ORIGIN}/`);
    mainWindow.setTitle(currentLabel);
  }
  return { ok: true };
}

function buildWatchdogDeps() {
  return {
    probe: probeConsole,
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
  app.on('second-instance', focusExisting);

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
  });
}

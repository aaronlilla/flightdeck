import {
  app, BrowserWindow, Menu, Tray, shell, dialog, ipcMain, nativeImage,
} from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { get as httpGet, type IncomingMessage } from 'node:http';

import { locateCheckout, type LocateFs } from './locate-checkout';
import { readSettings, updateSettings, type SettingsFs, type WindowBounds } from './settings';
import { bringUpConsole, type Spawned, type SupervisorDeps } from './console-supervisor';
import { probeConsole, waitUntilReachable } from './probe';
import { decideQuitAction } from './quit-rule';
import { hasLiveRun } from './fleet-state';
import { readGitHead } from './git-head';
import { consoleLabel } from './labels';
import { WINDOW_OPTIONS, STATUS_WINDOW_OPTIONS } from './window-options';
import { statusPageHtml } from './status-page';

const CONSOLE_ORIGIN = 'http://127.0.0.1:4120';

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

function spawnChild(command: string, args: string[], cwd: string): Spawned {
  const child = nodeSpawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
let tray: Tray | undefined;
let startedByThisApp = false;
let spawnedProcess: Spawned | undefined;
let currentLabel = 'Forge';

function showStatus(text: string): void {
  statusWindow?.webContents.send('status', text);
}

function logToStatus(line: string): void {
  statusWindow?.webContents.send('log', line);
}

function createStatusWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...STATUS_WINDOW_OPTIONS,
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

function createMainWindow(): BrowserWindow {
  const settings = readSettings(fsAdapter, settingsPath());
  const bounds = settings.windowBounds;
  const win = new BrowserWindow({
    ...WINDOW_OPTIONS,
    ...(bounds ?? {}),
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

  const deps: SupervisorDeps = {
    probe: probeConsole,
    spawn: spawnChild,
    fs: fsAdapter,
    join,
    nodeExecPath: process.execPath,
    waitUntilReachable,
    onLog: logToStatus,
  };

  showStatus('Bringing up the console…');
  const outcome = await bringUpConsole(checkoutDir, deps);

  if (outcome.mode === 'start-failed') {
    showStatus(outcome.reason);
    return;
  }

  startedByThisApp = outcome.mode === 'start';
  if (startedByThisApp) spawnedProcess = (outcome as { process: Spawned }).process;

  const head = startedByThisApp ? readGitHead(git(), checkoutDir) : undefined;
  currentLabel = consoleLabel(startedByThisApp ? 'started' : 'attached', head);

  showStatus('Loading the board…');
  mainWindow = createMainWindow();
  mainWindow.setTitle(currentLabel);
  await mainWindow.loadURL(`${CONSOLE_ORIGIN}/`);

  tray?.setToolTip(currentLabel);
  statusWindow?.close();
  statusWindow = undefined;
}

function buildTray(): Tray {
  const icon = nativeImage.createEmpty();
  const trayInstance = new Tray(icon);
  trayInstance.setToolTip('Forge');
  trayInstance.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: focusExisting },
    { label: 'Open in browser', click: () => void shell.openExternal(`${CONSOLE_ORIGIN}/`) },
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusExisting);

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
  });
}

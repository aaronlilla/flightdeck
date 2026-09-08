/**
 * Preload shared by the status window and the Settings window. Each side calls
 * `contextBridge.exposeInMainWorld` with its own name, so a window that never
 * loads `settingsPageHtml()` simply never touches `window.settingsBridge` and a
 * window that never loads `statusPageHtml()` never touches `window.statusBridge`
 * -- one compiled preload script, per `package.json`'s `build:preload`, rather
 * than a second esbuild entry for what is otherwise the same no-Node-access
 * posture the main window already keeps.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('statusBridge', {
  onStatus: (handler: (text: string) => void) => {
    ipcRenderer.on('status', (_event, text: string) => handler(text));
  },
  onLog: (handler: (line: string) => void) => {
    ipcRenderer.on('log', (_event, line: string) => handler(line));
  },
  onNeedFolder: (handler: () => void) => {
    ipcRenderer.on('need-folder', () => handler());
  },
  // C.3: whether the queue subsystem is running at all, pushed once at bootstrap
  // and again on every restart -- distinct from the ephemeral status/log lines,
  // which the next message always overwrites.
  onQueueState: (handler: (queueOn: boolean) => void) => {
    ipcRenderer.on('queue-state', (_event, queueOn: boolean) => handler(queueOn));
  },
  pickFolder: () => ipcRenderer.send('pick-folder'),
  // A bring-up attempt (first launch or a watchdog revive) did not get the
  // console to answer -- show the Retry button.
  onReviveFailed: (handler: () => void) => {
    ipcRenderer.on('revive-failed', () => handler());
  },
  retryConsole: () => ipcRenderer.send('retry-console'),
});

contextBridge.exposeInMainWorld('settingsBridge', {
  save: (entries: Record<string, string>) => ipcRenderer.send('save-forge-env', entries),
});

/**
 * Preload for the status window only. Exposes exactly the four calls the
 * status page needs and nothing else of Node or Electron, matching the main
 * window's own no-Node-access posture.
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
  pickFolder: () => ipcRenderer.send('pick-folder'),
});

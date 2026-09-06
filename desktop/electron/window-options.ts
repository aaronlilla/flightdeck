/**
 * How the main window is built, as plain data. No `electron` import: this is
 * the argument passed to `new BrowserWindow`, not the call itself, so the
 * security posture is something a test can read directly.
 */
export const WINDOW_OPTIONS = {
  width: 1280,
  height: 900,
  minWidth: 900,
  minHeight: 600,
  backgroundColor: '#0b0d12',
  show: false,
  frame: true,
  minimizable: true,
  maximizable: true,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  },
} as const;

/** The status window shown while the console comes up: small, no menu, no
 *  system chrome beyond a close button, since its whole job is a progress
 *  message and a log tail. */
export const STATUS_WINDOW_OPTIONS = {
  width: 560,
  height: 420,
  resizable: true,
  backgroundColor: '#0b0d12',
  show: false,
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  },
} as const;

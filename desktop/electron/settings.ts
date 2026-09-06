/**
 * The app's own small settings file, kept under Electron's userData directory.
 *
 * Two things live here: the checkout the user picked by hand (once
 * `locateCheckout` runs out of other ways to find one) and the window's last
 * bounds. Reading and writing go through an injected `fs`-shaped object so the
 * logic can be tested without touching a real disk.
 */
export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface Settings {
  checkoutDir?: string;
  windowBounds?: WindowBounds;
}

export interface SettingsFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string, encoding: 'utf8'): void;
  mkdirSync(path: string, options: { recursive: true }): void;
}

function dirOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx === -1 ? '.' : filePath.slice(0, idx);
}

export function readSettings(fs: SettingsFs, filePath: string): Settings {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Settings;
    return {};
  } catch {
    // A corrupt settings file is not a reason to refuse to start; it just means
    // nothing was remembered.
    return {};
  }
}

export function writeSettings(fs: SettingsFs, filePath: string, settings: Settings): void {
  fs.mkdirSync(dirOf(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf8');
}

export function updateSettings(
  fs: SettingsFs,
  filePath: string,
  patch: Partial<Settings>,
): Settings {
  const next = { ...readSettings(fs, filePath), ...patch };
  writeSettings(fs, filePath, next);
  return next;
}

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
  /** C.3: environment merged into the spawned console's own env at launch --
   *  FORGE_QUEUE, FORGE_JIRA_*, FORGE_REPO_*, FORGE_PORT and anything else the
   *  operator wants without setting a user-level environment variable, edited
   *  from the app's own Settings panel. A key set here always wins over one
   *  already in this process's own environment (see `mergeForgeEnv`). */
  forgeEnv?: Record<string, string>;
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

/**
 * C.3: `forgeEnv` merged onto a base environment (this process's own `process.env`) for
 * the spawned console -- the same spot `FORGE_REPO_DIR` is already set in `main.ts`'s
 * `resolveCheckoutDir`. A setting always wins over a value already in the base env, since
 * the whole point of the panel is to let an operator override a shortcut launch's bare
 * environment without setting one at the user level. Never mutates either argument.
 */
export function mergeForgeEnv(
  base: Record<string, string | undefined>,
  forgeEnv: Record<string, string> | undefined,
): Record<string, string | undefined> {
  if (!forgeEnv || Object.keys(forgeEnv).length === 0) return base;
  return { ...base, ...forgeEnv };
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

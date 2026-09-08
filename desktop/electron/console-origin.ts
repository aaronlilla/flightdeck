/**
 * Where the main window points. The forge server on 127.0.0.1:4120 is the
 * default and the only origin the supervisor probes or starts. FORGE_CONSOLE_ORIGIN
 * swaps in the Vite dev server for the window alone, so an edit under
 * src/console/ hot reloads inside the real shell while the API calls still go
 * through Vite's proxy to 4120.
 */
export const DEFAULT_CONSOLE_ORIGIN = 'http://127.0.0.1:4120';

export function consoleOrigin(env: { FORGE_CONSOLE_ORIGIN?: string | undefined }): string {
  const raw = env.FORGE_CONSOLE_ORIGIN?.trim();
  if (!raw) return DEFAULT_CONSOLE_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`FORGE_CONSOLE_ORIGIN is not a URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`FORGE_CONSOLE_ORIGIN must be http or https: ${raw}`);
  }
  return url.origin;
}

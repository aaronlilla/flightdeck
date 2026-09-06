/**
 * The window title and tray tooltip text, as a pure function of what the app
 * knows: whether it started or attached to the console, and the head string
 * (only available when it started the console itself, from a checkout with a
 * readable git history).
 */
export function consoleLabel(mode: 'started' | 'attached', head: string | undefined): string {
  if (mode === 'attached') return 'Forge — attached to running console';
  return head ? `Forge — ${head} (started)` : 'Forge — started';
}

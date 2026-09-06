/**
 * Deciding whether to attach to a console already running on 127.0.0.1:4120
 * or to start one, and what command starts it.
 */
export type ServerMode = 'attach' | 'start';

/** `probeReachable` is the caller's own check of the port; kept out of this
 *  function so the decision itself has no I/O in it. */
export function decideServerMode(alreadyAnswering: boolean): ServerMode {
  return alreadyAnswering ? 'attach' : 'start';
}

export interface StartCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface StartCommandFs {
  existsSync(path: string): boolean;
}

/**
 * The command that starts the console from `checkoutDir`. Prefers the built
 * entry run with the system Node; falls back to `npm run forge -- up` when
 * no build is present, which is the case for a checkout nobody has built yet.
 */
export function buildStartCommand(
  fs: StartCommandFs,
  join: (...parts: string[]) => string,
  checkoutDir: string,
  nodeExecPath: string,
): StartCommand {
  const builtEntry = join(checkoutDir, 'dist', 'forge', 'cli.js');
  if (fs.existsSync(builtEntry)) {
    return { command: nodeExecPath, args: [builtEntry, 'up'], cwd: checkoutDir };
  }
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return { command: npmCommand, args: ['run', 'forge', '--', 'up'], cwd: checkoutDir };
}

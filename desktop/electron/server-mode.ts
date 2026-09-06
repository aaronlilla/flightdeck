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
  /** Added to the child's environment. */
  env: Record<string, string>;
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
    // Packaged, `nodeExecPath` is this application's own executable rather than a
    // Node binary, so running a script with it starts a second copy of the desktop
    // app instead of the console. `ELECTRON_RUN_AS_NODE` makes that same executable
    // behave as the Node it already embeds, which also means the machine needs no
    // separate Node install. A real Node binary ignores the variable.
    return {
      command: nodeExecPath,
      args: [builtEntry, 'up'],
      cwd: checkoutDir,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return { command: npmCommand, args: ['run', 'forge', '--', 'up'], cwd: checkoutDir, env: {} };
}

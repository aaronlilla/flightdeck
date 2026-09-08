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
  /** Only needed when a `console.env.cmd` is found; the plain command path never calls it. */
  readFileSync?(path: string, encoding: 'utf8'): string;
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

/**
 * Parses the `set KEY=VALUE` lines written by `console.env.cmd`, which
 * carries every FORGE_* setting for the console-of-record launcher.
 * `rem` / `@rem` and `@echo` lines are skipped, and so is any other line
 * that is not a `set` line, since the script can carry batch syntax beyond
 * its settings. Only the first `=` splits key from value, so a value may
 * contain one itself. Values are taken literally; `%VAR%` references are
 * not expanded.
 */
export function parseEnvCmd(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^@?rem\b/i.test(line)) continue;
    if (/^@?echo\b/i.test(line)) continue;
    const match = /^@?set\s+([^=]+)=(.*)$/i.exec(line);
    if (!match) continue;
    const key = match[1]!.trim();
    const value = match[2]!;
    if (key) env[key] = value;
  }
  return env;
}

export interface LauncherPlan {
  kind: 'launcher';
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** The launcher script this plan runs, for logging. */
  scriptPath: string;
}

export interface CommandPlan {
  kind: 'command';
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** How many settings were merged in from `console.env.cmd`, for logging; 0 when there was no such file. */
  envFileVarsCount: number;
}

export type StartPlan = LauncherPlan | CommandPlan;

/**
 * Decides what actually starts the console on this machine. When the
 * console-of-record launcher (`<home>/.forge/console.launch.cmd`) exists,
 * that is the script Aaron already runs by hand after a reboot: it loops
 * `forge up`, restarting on exit code 75, with every FORGE_* setting carried
 * by its sibling `console.env.cmd`. Starting anything else brings up a
 * console missing all of that, so the launcher wins whenever it is there.
 *
 * The launcher runs detached on Windows through WMI (`Win32_Process.Create`
 * via PowerShell) rather than a plain `spawn(..., { detached: true })`,
 * because a detached child still lands in this app's job object on Windows.
 * A `taskkill /T` (or Electron's own child cleanup) aimed at this app would
 * take the console down with it; a WMI-created process belongs to no job.
 *
 * With no launcher script, this falls back to `buildStartCommand`'s plain
 * command and merges in whatever `console.env.cmd` provides (parsed by
 * `parseEnvCmd`), so a from-source checkout without the launcher installed
 * still picks up the FORGE_* configuration sitting next to it.
 */
export function planStart(
  fs: StartCommandFs,
  join: (...parts: string[]) => string,
  checkoutDir: string,
  nodeExecPath: string,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): StartPlan {
  const launcherPath = join(homeDir, '.forge', 'console.launch.cmd');
  if (fs.existsSync(launcherPath)) {
    if (platform === 'win32') {
      const createArgs = `@{ CommandLine = 'cmd.exe /c "${launcherPath}"' }`;
      return {
        kind: 'launcher',
        command: 'powershell',
        args: ['-NoProfile', '-Command', `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments ${createArgs}`],
        cwd: homeDir,
        env: {},
        scriptPath: launcherPath,
      };
    }
    // No non-Windows machine runs this today, but a direct exec of the script
    // is the honest equivalent of the WMI path above.
    return {
      kind: 'launcher', command: launcherPath, args: [], cwd: homeDir, env: {}, scriptPath: launcherPath,
    };
  }

  const envPath = join(homeDir, '.forge', 'console.env.cmd');
  const envFromFile = fs.existsSync(envPath) && fs.readFileSync
    ? parseEnvCmd(fs.readFileSync(envPath, 'utf8'))
    : {};

  const built = buildStartCommand(fs, join, checkoutDir, nodeExecPath);
  return {
    kind: 'command',
    command: built.command,
    args: built.args,
    cwd: built.cwd,
    env: { ...built.env, ...envFromFile },
    envFileVarsCount: Object.keys(envFromFile).length,
  };
}

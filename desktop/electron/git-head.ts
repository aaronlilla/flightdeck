/**
 * The branch and short commit of a checkout, for the window title and tray
 * tooltip. Only ever computed for a checkout this app itself started the
 * console from; an attached console's checkout is not known, so its title
 * says "attached" instead of guessing.
 */
export interface GitRunner {
  run(args: string[], cwd: string): string;
}

export function readGitHead(git: GitRunner, cwd: string): string | undefined {
  try {
    const branch = git.run(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim();
    const sha = git.run(['rev-parse', '--short', 'HEAD'], cwd).trim();
    if (!branch || !sha) return undefined;
    return `${branch} @ ${sha}`;
  } catch {
    return undefined;
  }
}

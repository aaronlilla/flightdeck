/**
 * Codex is reachable only inside a council round today, which blocks the tick for up to
 * fifteen minutes. This is the async escape hatch Aaron asked for: `ask` spawns Codex
 * detached (`codex_call.py start --run --cwd <cwd>`, read the tool's own doc comment for
 * the exact argv) and returns the run id at once; `status` and `result` wrap the tool's
 * own verbs. Nothing here ever awaits inside a tick -- `ask` returns as soon as the
 * detached spawn itself returns, long before the Codex turn (typically minutes) finishes.
 */
export interface CodexAdvisorRunner {
  /** Spawns `codex_call.py start ...` and returns once the CLI itself has printed the
   *  run id -- the CLI's own `start` detaches the real Codex turn, so this resolves in
   *  well under a second regardless of how long that turn takes. */
  start(argv: string[]): Promise<{ runId: string }>;
  status(runId: string): Promise<{ state: string; exitCode?: number }>;
  result(runId: string): Promise<{ exitCode: number; seconds?: number; ok?: boolean; [key: string]: unknown }>;
}

export interface CodexAdvisorJournal {
  append(event: Record<string, unknown>): unknown;
}

export interface CodexAdvisorDeps {
  runner: CodexAdvisorRunner;
  journal: CodexAdvisorJournal;
}

export interface AskInput {
  prompt: string;
  cwd: string;
  label: string;
  model?: string;
}

/** The exact argv `codex_call.py start` takes for one read-only run turn, prompt on the
 *  command line (the tool's own `run` subparser: `--prompt-file` or `--prompt`). */
export function argvFor(input: AskInput): string[] {
  const argv = ['start', '--run', '--cwd', input.cwd, '--prompt', input.prompt, '--label', input.label];
  if (input.model) argv.push('--model', input.model);
  return argv;
}

/** Production wiring: `FORGE_CODEX_CALL` (the same env var `codexLane.ts` reads) names
 *  the command prefix, e.g. `python <path>/codex_call.py`. Every specimen in this
 *  repository supplies its own fake `CodexAdvisorRunner` instead -- nothing here is
 *  reachable from a test. */
export function realCodexAdvisorRunner(env: NodeJS.ProcessEnv = process.env): CodexAdvisorRunner {
  const prefix = env['FORGE_CODEX_CALL'];
  const runOnce = async (argv: string[]): Promise<{ exitCode: number | null; stdout: string }> => {
    const { spawn } = await import('node:child_process');
    const parts = (prefix ?? '').split(' ').filter(Boolean);
    const command = parts[0];
    if (!command) return { exitCode: null, stdout: '' };
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, [...parts.slice(1), ...argv], { env, shell: false });
      } catch {
        resolve({ exitCode: null, stdout: '' });
        return;
      }
      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.on('error', () => resolve({ exitCode: null, stdout }));
      child.on('close', (code) => resolve({ exitCode: code, stdout }));
    });
  };
  return {
    async start(argv) {
      const { stdout } = await runOnce(argv);
      const parsed = JSON.parse(stdout) as { run_id: string };
      return { runId: parsed.run_id };
    },
    async status(runId) {
      const { stdout } = await runOnce(['status', runId]);
      const parsed = JSON.parse(stdout) as { state: string; exit_code?: number };
      return { state: parsed.state, ...(parsed.exit_code !== undefined ? { exitCode: parsed.exit_code } : {}) };
    },
    async result(runId) {
      const { stdout, exitCode } = await runOnce(['result', runId]);
      try {
        const parsed = JSON.parse(stdout) as { ok?: boolean; seconds?: number };
        return { exitCode: exitCode ?? -1, ok: parsed.ok, seconds: parsed.seconds };
      } catch {
        return { exitCode: exitCode ?? -1 };
      }
    },
  };
}

export class CodexAdvisor {
  constructor(private readonly deps: CodexAdvisorDeps) {}

  /** Returns the run id the moment the detached spawn itself returns -- never awaits
   *  `status` or `result`, so a caller inside a tick never blocks on the Codex turn
   *  itself finishing. Journals only the id and the label, never the prompt. */
  async ask(input: AskInput): Promise<{ id: string }> {
    const { runId } = await this.deps.runner.start(argvFor(input));
    this.deps.journal.append({ event: 'codex.started', id: runId, label: input.label });
    return { id: runId };
  }

  async status(id: string): Promise<{ state: string; exitCode?: number }> {
    return this.deps.runner.status(id);
  }

  /** Refuses (via the runner's own `result` verb, which exits non-zero on a still-going
   *  run) rather than waiting. Journals the outcome, never the prompt or any Codex
   *  output text. */
  async result(id: string): Promise<{ exitCode: number; seconds?: number; ok?: boolean }> {
    const outcome = await this.deps.runner.result(id);
    this.deps.journal.append({
      event: 'codex.finished', id, exitCode: outcome.exitCode, seconds: outcome.seconds,
    });
    return outcome;
  }
}

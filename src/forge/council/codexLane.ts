/**
 * The real `CodexLane` (`roles.ts`): a read-only call through the one sanctioned route to
 * Codex, the harness tool named by `FORGE_CODEX_CALL` (a command prefix -- for example
 * `python <path>/codex_call.py`; the path is site-specific and lives on the launch line,
 * never in this file). That tool pins a read-only sandbox and never-approve on every call
 * and writes one JSON envelope to stdout, whose shape is
 * `dev-harness/tools/schemas/codex-findings.schema.json`.
 *
 * The subprocess itself is behind `CodexCallRunner`, injected, so every specimen in this
 * repository drives this file through a fake and never spawns anything or touches the
 * network (the same guardrail `roles.ts` states for the Sonnet lenses).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { configDirForSession, loadAccounts } from '../accounts.js';
import { readAccountUsage } from '../accounts-usage.js';
import { redact } from '../contracts.ts';
import type { CouncilFinding } from '../contracts.ts';
import type { Journal } from '../journal.ts';
import { killTree } from '../exec.ts';
import { workerEnv } from '../worker.ts';
import type { CodexLane, CodexLaneInput, CodexLaneResult } from './roles.ts';

const DEFAULT_TIMEOUT_S = 900;

/** One subprocess call: argv, cwd and env in, exit code and stdout out. Never rejects --
 *  a codex binary that cannot start is data for the lane to read, not an exception for it
 *  to catch. */
export interface CodexCallResult {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
}

export interface CodexCallRequest {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutS: number;
}

export interface CodexCallRunner {
  run(request: CodexCallRequest): Promise<CodexCallResult>;
}

/** Production wiring only. Every specimen supplies its own fake instead (guardrail: no
 *  process spawned and no network reached by anything this repository tests). */
export const REAL_CODEX_CALL_RUNNER: CodexCallRunner = {
  run(request) {
    return new Promise((resolve) => {
      const [command, ...args] = request.argv;
      if (!command) {
        resolve({ exitCode: null, stdout: '', timedOut: false });
        return;
      }
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, args, { cwd: request.cwd, env: request.env, shell: false });
      } catch {
        resolve({ exitCode: null, stdout: '', timedOut: false });
        return;
      }
      let stdout = '';
      let timedOut = false;
      let settled = false;
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr?.on('data', () => { /* the envelope always travels on stdout; stderr is diagnostic-only and never parsed */ });
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) killTree(child.pid);
      }, Math.max(1, request.timeoutS) * 1000);
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, timedOut });
      };
      child.on('close', finish);
      child.on('error', () => finish(null));
    });
  },
};

/** The one finding shape `codex-findings.schema.json` demands, read permissively enough
 *  that an envelope this file has never seen still parses as long as it matches the
 *  contract; anything that does not is an unparseable reply, never a thrown error. */
const CodexRawFindingSchema = z.object({
  file: z.string().min(1),
  line_start: z.number().int(),
  line_end: z.number().int(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string().min(1),
  claim: z.string().min(1),
  failure_scenario: z.string().min(1),
  confidence: z.number().min(0).max(1),
  recommendation: z.string().min(1),
});

const CodexEnvelopeSchema = z.object({
  ok: z.boolean(),
  run_id: z.string().optional(),
  model: z.string().optional(),
  duration_s: z.number().optional(),
  error: z.string().nullable().optional(),
  result: z.object({
    verdict: z.string().optional(),
    summary: z.string().optional(),
    findings: z.array(CodexRawFindingSchema).default([]),
    coverage_notes: z.string().optional(),
  }).optional(),
});

type CodexRawFinding = z.infer<typeof CodexRawFindingSchema>;

/** A 0-1 confidence number, the schema's own shape, read against `CouncilFinding`'s
 *  three-band enum -- the same low/medium/high split a lens's own confidence already
 *  uses, so a Codex finding and a lens finding compare on the same scale downstream. */
function confidenceBand(value: number): 'low' | 'medium' | 'high' {
  if (value >= 0.7) return 'high';
  if (value >= 0.4) return 'medium';
  return 'low';
}

/** Paths the schema already promises are repository-relative, made agnostic of the
 *  separator the platform running Codex used, and, defensively, of a `cwd` prefix a
 *  reply might still carry despite the schema's own instruction not to. */
function normalizePath(file: string, cwd: string): string {
  const forward = file.replace(/\\/g, '/');
  const cwdForward = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (cwdForward && forward.toLowerCase().startsWith(`${cwdForward.toLowerCase()}/`)) {
    return forward.slice(cwdForward.length + 1);
  }
  return forward;
}

function toFinding(raw: CodexRawFinding, cwd: string): CouncilFinding {
  return {
    member: 'codex',
    file: normalizePath(raw.file, cwd),
    line: raw.line_start,
    claim: redact(`${raw.title} (lines ${raw.line_start}-${raw.line_end}): ${raw.claim}`),
    failureScenario: redact(`${raw.failure_scenario} Recommendation: ${raw.recommendation}`),
    severity: raw.severity,
    confidence: confidenceBand(raw.confidence),
  };
}

/** The one finding a caller sees when the lane was attempted but produced nothing
 *  trustworthy: highest severity the council knows, so an uncovered lane reads as a red
 *  flag for the judge rather than a silent pass. */
function uncoveredFinding(reason: string): CouncilFinding {
  return {
    member: 'codex',
    file: '(codex)',
    line: 0,
    claim: `Codex lane uncovered: ${redact(reason)}`,
    failureScenario: 'the codex lane could not be run for this round, so its coverage of this diff is missing entirely',
    severity: 'critical',
    confidence: 'high',
  };
}

function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

function writeFocusFile(brief: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'forge-codex-'));
  const path = join(dir, 'focus.md');
  writeFileSync(path, brief, 'utf8');
  return { path, dir };
}

export interface CodexLaneDeps {
  /** Journal for the round's `council.lens` row. Omitted in a specimen that does not
   *  care to read it back. */
  journal?: Journal;
  /** The label suffix, normally `${repo}#${pr}` -- the same string `reasonerJudge` and
   *  `reasonerLensRunner` already take as their own `run` parameter. */
  run?: string;
  runner?: CodexCallRunner;
  env?: NodeJS.ProcessEnv;
  /** Overrides `FORGE_CODEX_CALL`. */
  callCommand?: string;
  /** Overrides `FORGE_CODEX_TIMEOUT_S`, default 900. */
  timeoutS?: number;
}

/**
 * The real Codex lane. `reasonerRoles.ts`'s `codexLaneFor` wires this in production when
 * `council.codex` is `'on'`; every specimen builds one directly with a fake runner
 * instead.
 */
export function makeCodexLane(deps: CodexLaneDeps = {}): CodexLane {
  const runner = deps.runner ?? REAL_CODEX_CALL_RUNNER;
  const env = deps.env ?? workerEnv(process.env);
  // A linked ChatGPT account with headroom becomes this call's Codex home; with none
  // linked the call runs under the machine's own `~/.codex`, as before accounts existed.
  const codexHome = configDirForSession(loadAccounts(), readAccountUsage(), {}, Date.now(), undefined, 'codex').configDir;
  if (codexHome && !deps.env) env['CODEX_HOME'] = codexHome;
  const timeoutS = deps.timeoutS
    ?? (Number(process.env['FORGE_CODEX_TIMEOUT_S']) || DEFAULT_TIMEOUT_S);
  const label = `council ${deps.run ?? 'unknown'}`;

  return {
    async run(input: CodexLaneInput): Promise<CodexLaneResult> {
      if (!input.cwd || !input.baseRef) {
        return {
          ran: false,
          findings: [],
          reason: 'the codex lane needs both cwd and baseRef; at least one was not supplied',
        };
      }

      const callCommand = deps.callCommand ?? process.env['FORGE_CODEX_CALL'];
      if (!callCommand) {
        return { ran: false, findings: [], reason: 'FORGE_CODEX_CALL is not set' };
      }

      const focus = writeFocusFile(input.brief);
      let call: CodexCallResult;
      try {
        const argv = [
          ...splitCommand(callCommand),
          'review', '--base', input.baseRef, '--cwd', input.cwd,
          '--focus-file', focus.path, '--label', label, '--timeout', String(timeoutS),
        ];
        call = await runner.run({ argv, cwd: input.cwd, env, timeoutS });
      } finally {
        try { rmSync(focus.dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }

      let reason: string | undefined;
      let meta: { run_id?: string; model?: string; duration_s?: number } = {};
      let findings: CouncilFinding[] = [];

      if (call.timedOut) {
        reason = `codex timed out after ${timeoutS}s`;
      } else if (call.exitCode !== 0) {
        reason = `codex exited ${call.exitCode ?? 'null'}`;
      } else {
        let envelope: unknown;
        try {
          envelope = JSON.parse(call.stdout);
        } catch {
          envelope = undefined;
        }
        const parsed = envelope === undefined ? undefined : CodexEnvelopeSchema.safeParse(envelope);
        if (!parsed || !parsed.success) {
          reason = 'codex returned output on stdout that was not a valid findings envelope';
        } else {
          meta = { run_id: parsed.data.run_id, model: parsed.data.model, duration_s: parsed.data.duration_s };
          if (!parsed.data.ok) {
            reason = parsed.data.error ?? 'codex reported ok: false with no error message';
          } else {
            findings = (parsed.data.result?.findings ?? []).map((f) => toFinding(f, input.cwd!));
          }
        }
      }

      if (reason) findings = [uncoveredFinding(reason)];

      deps.journal?.append({
        event: 'council.lens', actor: 'council', lane: 'codex',
        ...(meta.run_id ? { run_id: meta.run_id } : {}),
        ...(meta.model ? { model: meta.model } : {}),
        ...(meta.duration_s !== undefined ? { duration_s: meta.duration_s } : {}),
        findings: findings.length,
        ...(reason ? { reason: redact(reason) } : {}),
      });

      return { ran: true, findings };
    },
  };
}

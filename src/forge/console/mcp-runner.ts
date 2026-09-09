/**
 * Talks to the real `claude` CLI to find out what an MCP server's connection state
 * actually is, rather than treating "the URL answered 200" or "the binary is on PATH"
 * as a health check. `claude mcp list` has no `--json` flag, so this parses the text
 * table it prints; the row grammar and every mapped symbol below were captured live
 * against the fleet's own config dir, 2026-09-08, on `claude 2.1.263` -- see the goal
 * brief's Verified-state section for the literal transcript.
 */
import { existsSync, readFileSync as nodeReadFileSync } from 'node:fs';
import { join } from 'node:path';

import { run as execRun, type RunRequest } from '../exec.js';
import { fleetConfigDir, workspaceRoot } from '../paths.js';
import { commandOnPath } from './integrations.js';
import type { McpConnState } from '../../shared/console-model.js';

/** Where the fleet's workers actually run from -- the root every worker's `claude` CLI
 *  is launched from, which is not necessarily wherever `forge up` itself happens to be
 *  running from (that's `workspaceRoot()`). `FORGE_WORKER_CWD` names it explicitly for a
 *  machine whose fleet workers run from a fixed root; per this repository's own
 *  machine-agnostic rule (`paths.ts`'s file comment: "no path is hardcoded here"), no
 *  literal path lives in source, so an unset override falls back to `workspaceRoot()`.
 *  `opts.cwd` is only there so a test can prove this function's return value is what
 *  reaches the spawn call, not a value passed through opts. */
function fleetWorkerCwd(): string {
  return process.env['FORGE_WORKER_CWD'] ?? workspaceRoot();
}

export type { McpConnState };

export interface McpRow {
  name: string;
  target: string;
  state: McpConnState;
  lastError: string | null;
}

interface ParsedLine {
  name: string;
  target: string;
  symbol: string;
  statusText: string;
}

/** `claude mcp list` prints one row per server as
 *  `<name>: <url-or-command>[ (transport)] - <symbol> <status text>`, plus assorted
 *  banner and hook-noise lines that carry no ` - ` separator (or, like a stdio command's
 *  drive letter, a colon that is not followed by a space). Splitting on the LAST
 *  ` - ` and the FIRST `: ` survives both a name that itself contains colons
 *  (`plugin:slack:slack`) and a command target that contains one (`C:/...`). */
export function parseMcpListLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const dashIdx = trimmed.lastIndexOf(' - ');
  if (dashIdx === -1) return null;
  const left = trimmed.slice(0, dashIdx);
  const right = trimmed.slice(dashIdx + 3);
  const colonIdx = left.indexOf(': ');
  if (colonIdx === -1) return null;
  const name = left.slice(0, colonIdx).trim();
  const target = left.slice(colonIdx + 2).trim();
  const spaceIdx = right.indexOf(' ');
  if (spaceIdx === -1 || !name || !target) return null;
  const symbol = right.slice(0, spaceIdx).trim();
  const statusText = right.slice(spaceIdx + 1).trim();
  if (!symbol || !statusText) return null;
  return { name, target, symbol, statusText };
}

function mapState(parsed: ParsedLine): McpRow {
  switch (parsed.symbol) {
    case '\u2714': // ✔ Connected
      return { name: parsed.name, target: parsed.target, state: 'connected', lastError: null };
    case '!': // Needs authentication
      return { name: parsed.name, target: parsed.target, state: 'needs-login', lastError: null };
    case '\u23f8': // ⏸ Pending approval
      return { name: parsed.name, target: parsed.target, state: 'pending-approval', lastError: null };
    default:
      // Any other symbol (observed live: none; synthesized: ✗) reads as a real failure,
      // carrying the CLI's own status text rather than a generic sentence.
      return { name: parsed.name, target: parsed.target, state: 'failed', lastError: parsed.statusText };
  }
}

export interface ClaudeMcpListOptions {
  spawnFn?: RunRequest['spawnFn'];
  cwd?: string;
  configDir?: string;
  /** Overrides the fallback file read, so a specimen can prove which paths were opened
   *  (and, just as importantly, which were never opened) without touching real disk. */
  readFile?: (path: string, encoding: BufferEncoding) => string;
  exists?: (path: string) => boolean;
}

export interface ClaudeMcpListResult {
  rows: McpRow[];
  ok: boolean;
}

const TIMEOUT_MS = 5000;

async function fallbackFromClaudeJson(configDir: string, opts: ClaudeMcpListOptions): Promise<ClaudeMcpListResult> {
  const exists = opts.exists ?? existsSync;
  const readFile = opts.readFile ?? ((path: string, encoding: BufferEncoding) => nodeReadFileSync(path, encoding));
  const claudeJsonPath = join(configDir, '.claude.json');
  if (!exists(claudeJsonPath)) return { rows: [], ok: false };
  try {
    const parsed = JSON.parse(readFile(claudeJsonPath, 'utf8')) as {
      mcpServers?: Record<string, { url?: string; command?: string }>;
    };
    const servers = parsed.mcpServers ?? {};
    const rows: McpRow[] = Object.entries(servers).map(([name, spec]) => ({
      name,
      target: spec.url ?? spec.command ?? '',
      // The server list alone says nothing about connection state -- this is the
      // documented last-resort fallback, for the list only, never for credentials.
      state: 'unknown' as const,
      lastError: null,
    }));
    return { rows, ok: true };
  } catch {
    return { rows: [], ok: false };
  }
}

/** Runs `claude mcp list` under the fleet's own config dir and workspace, parses the
 *  live-verified row grammar, and ignores every non-matching line rather than
 *  surfacing it as a phantom server. Falls back to the fleet config dir's own
 *  `.claude.json` for the server list only when `claude` is not on PATH -- never for
 *  credentials, and never as the primary path. Bounded at 5s, matching every other
 *  probe in this module: a hung `claude mcp list` resolves `unknown`, not hung. */
export async function claudeMcpList(opts: ClaudeMcpListOptions = {}): Promise<ClaudeMcpListResult> {
  const configDir = opts.configDir ?? fleetConfigDir(opts.exists);
  const cwd = fleetWorkerCwd();

  const available = await commandOnPath('claude', opts.spawnFn);
  if (!available) return fallbackFromClaudeJson(configDir, opts);

  const result = await Promise.race([
    execRun({
      argv: ['claude', 'mcp', 'list'],
      cwd,
      owner: 'console-integrations-mcp-list',
      cls: 'script',
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
    }),
    new Promise<null>((resolve) => { setTimeout(() => resolve(null), TIMEOUT_MS); }),
  ]);

  if (result === null || result.returncode === null) return { rows: [], ok: false };

  const rows = (result.tail ?? result.full ?? '')
    .split('\n')
    .map(parseMcpListLine)
    .filter((row): row is ParsedLine => row !== null)
    .map(mapState);

  return { rows, ok: true };
}

/** `claude mcp get <name>` for one server's full detail beyond what `list` printed
 *  (`Type`, `URL`, the full `Status` line) -- same status symbols as `list`, one block. */
export async function claudeMcpGet(name: string, opts: ClaudeMcpListOptions = {}): Promise<{ ok: boolean; statusLine: string | null }> {
  const configDir = opts.configDir ?? fleetConfigDir(opts.exists);
  const cwd = fleetWorkerCwd();

  const result = await Promise.race([
    execRun({
      argv: ['claude', 'mcp', 'get', name],
      cwd,
      owner: `console-integrations-mcp-get-${name}`,
      cls: 'script',
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
    }),
    new Promise<null>((resolve) => { setTimeout(() => resolve(null), TIMEOUT_MS); }),
  ]);

  if (result === null || result.returncode !== 0) return { ok: false, statusLine: null };
  const text = result.tail ?? result.full ?? '';
  const statusLine = text.split('\n').find((line) => line.trim().startsWith('Status:'))?.trim() ?? null;
  return { ok: true, statusLine };
}

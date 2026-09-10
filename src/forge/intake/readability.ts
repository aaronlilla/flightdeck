/**
 * Readable PR rule (2026-09-09, Aaron): Joe cannot read what the forge writes.
 *
 * The contract and specimens are machine data, not repo data (R-59, 2026-09-10): a real
 * contract names real repos and real PR prose, which is exactly what this repo's
 * `check:agnostic` forbids. `install.ps1` on dev-harness writes the real contract to
 * `readabilityDir()` (default `~/.forge/readability`); this module loads it from there at
 * run time and never throws on a missing or malformed file -- see `loadContract`.
 *
 * `voiceGuard.comment()` on the Jira write client and the PR-create path in chain/worker
 * both call `readabilityVerdict` before anything reaches a real write -- see `jira.ts` and
 * `chain.ts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readabilityDir } from '../paths.ts';

export interface ReadabilityContract {
  verdicts: string[];
  surfaces: string[];
  outward_repos: string[];
  ticket_key_repos: string[];
  ticket_key_pattern: string;
  banned_words: string[];
  required_sections: string[];
  prose_ceiling_words: Record<string, number>;
  words_deny_from: string;
  production_ceiling: { lines: number; files: number };
  exempt_globs: string[];
  fence_max_lines: number;
  /** G4 (R-59, 2026-09-10): a sha256 of the source fixtures.json, stamped by
   *  `install.ps1` at install time. Absent on a contract this stamp predates; never
   *  compared against anything at load (this process caches its contract once and
   *  never re-reads the file -- see `cachedState` below), so it names what is loaded
   *  rather than detecting drift against a newer install nobody has restarted for. */
  contract_version?: string;
}

export type ContractLoadResult =
  | { ok: true; contract: ReadabilityContract }
  | { ok: false; reason: string; dir: string };

const REQUIRED_STRING_ARRAYS: (keyof ReadabilityContract)[] = [
  'outward_repos', 'ticket_key_repos', 'banned_words', 'required_sections', 'exempt_globs',
];
const REQUIRED_STRINGS: (keyof ReadabilityContract)[] = ['ticket_key_pattern', 'words_deny_from'];

/** Structural validation, not a full schema: catches the shape a syntactically-valid
 *  but semantically-broken `contract.json` (a hand-edit, a truncated write) would need
 *  to crash `readabilityVerdict` on -- an array field that is a string, a missing
 *  `production_ceiling`, a non-numeric `fence_max_lines`. Returns the first problem
 *  found, or undefined when the shape is usable. */
function contractShapeProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return 'contract is not an object';
  const c = value as Record<string, unknown>;
  for (const key of REQUIRED_STRING_ARRAYS) {
    if (!Array.isArray(c[key]) || !(c[key] as unknown[]).every((v) => typeof v === 'string')) {
      return `"${key}" must be an array of strings`;
    }
  }
  for (const key of REQUIRED_STRINGS) {
    if (typeof c[key] !== 'string') return `"${key}" must be a string`;
  }
  if (typeof c['prose_ceiling_words'] !== 'object' || c['prose_ceiling_words'] === null) {
    return '"prose_ceiling_words" must be an object';
  }
  const ceiling = c['production_ceiling'];
  if (
    typeof ceiling !== 'object' || ceiling === null
    || typeof (ceiling as Record<string, unknown>)['lines'] !== 'number'
    || typeof (ceiling as Record<string, unknown>)['files'] !== 'number'
  ) {
    return '"production_ceiling" must be an object with numeric "lines" and "files"';
  }
  if (typeof c['fence_max_lines'] !== 'number') return '"fence_max_lines" must be a number';
  return undefined;
}

/** Reads `<dir>/contract.json`. Never throws: a missing directory, a missing file, a
 *  malformed file, and a structurally-broken (but valid-JSON) file are all reported as
 *  `{ok: false}` rather than crashing the caller -- this is what keeps a write LOUD
 *  instead of fail-closed when the contract is absent or unusable (see
 *  `readabilityVerdict`). */
export function loadContract(dir: string): ContractLoadResult {
  const contractPath = path.join(dir, 'contract.json');
  let raw: string;
  try {
    raw = readFileSync(contractPath, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `no contract at ${contractPath}: ${reason}`, dir };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `malformed contract at ${contractPath}: ${reason}`, dir };
  }
  const problem = contractShapeProblem(parsed);
  if (problem) {
    return { ok: false, reason: `invalid contract at ${contractPath}: ${problem}`, dir };
  }
  return { ok: true, contract: parsed as ReadabilityContract };
}

/** Loaded once and cached: no caller re-reads the contract file per write. Populated by
 *  `initReadabilityContract` (called once from `cli.ts`'s `up`); a caller that runs before
 *  `up` has had a chance to init (a test, a one-off script) gets a lazy first load here,
 *  still cached from then on. */
let cachedState: ContractLoadResult | null = null;

/** Loads (or reloads) the contract from `dir` (default `readabilityDir()`) and caches the
 *  result for every subsequent `getReadabilityContractState`/`readabilityVerdict` call.
 *  This is the one place the file is read; call it once at startup. */
export function initReadabilityContract(dir: string = readabilityDir()): ContractLoadResult {
  cachedState = loadContract(dir);
  return cachedState;
}

export function getReadabilityContractState(): ContractLoadResult {
  if (cachedState === null) cachedState = loadContract(readabilityDir());
  return cachedState;
}

/** Test-only: clears the cache so a specimen can point `FORGE_READABILITY_DIR` at a fresh
 *  temp dir and force a real reload instead of reusing another test's cached state. */
export function resetReadabilityContractForTests(): void {
  cachedState = null;
}

/** Built once (in `cli.ts`'s `up`) and threaded into every write path instead of each one
 *  re-reading the contract file for itself. `deps.dir` lets a specimen or a differently
 *  laid-out machine point it elsewhere. */
export function readabilityFor(deps: { dir?: string } = {}): {
  state: () => ContractLoadResult;
  verdict: typeof readabilityVerdict;
} {
  initReadabilityContract(deps.dir);
  return { state: getReadabilityContractState, verdict: readabilityVerdict };
}

/** Entries whose contract note says they match as a prefix rather than a whole word. */
const PREFIX_BANNED = new Set(['orchestrat', 'gate g']);

export interface DiffStatEntry {
  path: string;
  added: number;
  deleted: number;
}

export type ReadabilityVerdictKind = 'DENY' | 'ADVISE' | 'SILENT';

export interface ReadabilityResult {
  verdict: ReadabilityVerdictKind;
  reason: string;
}

/**
 * The five secret shapes flightdeck refuses (the hook side of the contract does not scan
 * for secrets -- this half is flightdeck-only, per `contract.secret_shape.scope`). Exported
 * so item 1's PR/Jira handoff assembly can run the same check over `howToRun`/`code`
 * fields before they ever reach a rendered body, per the brief.
 */
const SECRET_LITERAL_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{36}/,
  /sk-[A-Za-z0-9]{20,}/,
  /Bearer [A-Za-z0-9._-]{20,}/,
];

const SECRET_ASSIGNMENT_PATTERN = /\b(password|token|secret|apikey|api_key)\s*[:=]\s*"?([^\s",;)]+)"?/gi;

/** True if `value` reads as a placeholder rather than a real secret. */
function isPlaceholderSecretValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^<.*>$/.test(trimmed)) return true;
  if (/your[-_ ]?value|replace|xxxx|placeholder/i.test(trimmed)) return true;
  return false;
}

export function hasSecretShape(text: string): { hit: boolean; match?: string } {
  for (const pattern of SECRET_LITERAL_PATTERNS) {
    const m = pattern.exec(text);
    if (m) return { hit: true, match: m[0] };
  }
  SECRET_ASSIGNMENT_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECRET_ASSIGNMENT_PATTERN.exec(text))) {
    if (isPlaceholderSecretValue(m[2] ?? '')) continue;
    return { hit: true, match: m[0] };
  }
  return { hit: false };
}

/** Strip fenced code blocks (```...```), leaving everything else untouched. */
function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

/** Strip inline backtick spans (`...`). */
function stripInlineBackticks(text: string): string {
  return text.replace(/`[^`\n]*`/g, '');
}

function stripHeadings(text: string): string {
  return text.replace(/^#{1,6}\s+.*$/gm, '');
}

export function proseWordCount(text: string): number {
  const stripped = stripInlineBackticks(stripHeadings(stripFences(text)));
  const tokens = stripped.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  return tokens.length;
}

function findBannedWords(text: string, bannedWords: string[]): string[] {
  const prose = stripInlineBackticks(stripFences(text));
  const hits: string[] = [];
  for (const word of bannedWords) {
    const lower = word.toLowerCase();
    const isPrefix = PREFIX_BANNED.has(lower);
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = isPrefix ? new RegExp(escaped, 'i') : new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(prose)) hits.push(word);
  }
  return hits;
}

/** Minimal glob-to-regex: `**` and `*` both match across path separators. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`(^|/)${escaped}$|^${escaped}$`, 'i');
}

/** Compiled once per distinct `exemptGlobs` array (the contract is loaded once and
 *  cached, so in practice this is once per process) rather than once per diff path --
 *  `readabilityVerdict` calls this per file in a diff, and a PR touching dozens of
 *  files has no reason to recompile the same handful of glob patterns that many times. */
const EXEMPT_MATCHER_CACHE = new WeakMap<string[], RegExp[]>();

function isExempt(filePath: string, exemptGlobs: string[]): boolean {
  let matchers = EXEMPT_MATCHER_CACHE.get(exemptGlobs);
  if (!matchers) {
    matchers = exemptGlobs.map(globToRegExp);
    EXEMPT_MATCHER_CACHE.set(exemptGlobs, matchers);
  }
  return matchers.some((re) => re.test(filePath)) || /test/i.test(filePath.split('/').pop() ?? '');
}

/** Whether a documented path `a` and a diff path `b` name the same file -- equal, or one
 *  a path-suffix of the other at a `/` boundary. A bare substring match (G3, 2026-09-10)
 *  let "AB.cs" count as documenting "B.cs" since 'AB.cs'.includes('B.cs') is true. */
function pathsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

interface HeadingMatch {
  level: number;
  text: string;
  start: number;
  bodyStart: number;
}

function findHeadings(text: string): HeadingMatch[] {
  const headings: HeadingMatch[] = [];
  const re = /^(#{1,6})\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const marker = m[1] ?? '';
    const label = m[2] ?? '';
    headings.push({ level: marker.length, text: label.trim(), start: m.index, bodyStart: m.index + m[0].length });
  }
  return headings;
}

function sectionBody(text: string, headings: HeadingMatch[], index: number): string {
  const current = headings[index];
  if (!current) return '';
  const next = headings[index + 1];
  const end = next ? next.start : text.length;
  return text.slice(current.bodyStart, end).trim();
}

function stripBackticksFromHeading(text: string): string {
  return text.replace(/`/g, '').trim();
}

const PATH_LINE_HEADING = /^(.+?):(\d+)$/;

function fenceAfter(text: string, fromIndex: number): { content: string; lineCount: number } | null {
  const rest = text.slice(fromIndex);
  const m = /^\s*\n*```[^\n]*\n([\s\S]*?)```/.exec(rest);
  if (!m) return null;
  const content = m[1] ?? '';
  const lineCount = content.split('\n').filter((l) => l.trim().length > 0).length;
  return { content: content.trim(), lineCount };
}

export function readabilityVerdict(
  surface: string,
  repo: string | null,
  title: string,
  body: string,
  diffStats: DiffStatEntry[] | null | undefined,
  asOf: string,
): ReadabilityResult {
  if (process.env['HARNESS_READABILITY_OFF'] === '1') {
    return { verdict: 'SILENT', reason: 'HARNESS_READABILITY_OFF=1' };
  }

  // Unconfigured is LOUD, never fail-closed: `readability.unconfigured` is journaled once
  // per console start (item 4, `console/server.ts`), and a write goes through unrefused --
  // the alarm is the journal row and the Settings line, not a blocked write.
  const state = getReadabilityContractState();
  if (!state.ok) {
    return { verdict: 'SILENT', reason: `readability rule not configured (${state.reason})` };
  }
  const contract = state.contract;
  const outwardRepos = contract.outward_repos;
  const ticketKeyRepos = contract.ticket_key_repos;
  const ticketKeyPattern = new RegExp(contract.ticket_key_pattern, 'g');
  const bannedWords = contract.banned_words;
  const requiredSections = contract.required_sections;
  const proseCeilings = contract.prose_ceiling_words;
  const productionCeiling = contract.production_ceiling;
  const fenceMaxLines = contract.fence_max_lines;
  const exemptGlobs = contract.exempt_globs;
  const wordsDenyFrom = contract.words_deny_from;

  const isJira = surface.startsWith('jira');
  const inScope = isJira || (repo !== null && outwardRepos.includes(repo));
  if (!inScope) {
    return { verdict: 'SILENT', reason: `${repo ?? 'no repo'} is not an outward-facing repo` };
  }

  const fullText = `${title}\n${body}`;

  // Secret shape dominates: a pasted credential is refused before anything else runs.
  const secret = hasSecretShape(fullText);
  if (secret.hit) {
    return finalize('DENY', [`secret-shaped token in the rendered text ("${secret.match}")`]);
  }

  const findings: { level: ReadabilityVerdictKind; message: string }[] = [];

  if (surface === 'pr-title' && repo && ticketKeyRepos.includes(repo)) {
    const matches = title.match(ticketKeyPattern) ?? [];
    if (matches.length === 0) {
      findings.push({ level: 'DENY', message: `no ticket key matching ${contract.ticket_key_pattern} found in the title` });
    } else if (matches.length > 1) {
      findings.push({ level: 'DENY', message: `expected exactly one ticket key, found ${matches.length}` });
    }
  }

  const bannedHits = findBannedWords(fullText, bannedWords);
  if (bannedHits.length > 0) {
    findings.push({ level: 'DENY', message: `banned word(s) in prose: ${bannedHits.join(', ')}` });
  }

  const needsSections = surface === 'pr-body' || surface === 'jira-description';
  let documentedProductionPaths: string[] = [];
  if (needsSections) {
    const headings = findHeadings(body);
    for (const name of requiredSections) {
      const idx = headings.findIndex((h) => h.text.toLowerCase() === name.toLowerCase());
      if (idx < 0) {
        findings.push({ level: 'DENY', message: `missing required section "${name}"` });
        continue;
      }
      const content = sectionBody(body, headings, idx);
      if (!content) {
        findings.push({ level: 'DENY', message: `section "${name}" is empty` });
      }
    }

    const pathHeadings = headings.filter((h) => PATH_LINE_HEADING.test(stripBackticksFromHeading(h.text)));
    if (pathHeadings.length === 0) {
      findings.push({ level: 'DENY', message: 'no path:line heading with a fenced code block found' });
    }
    for (const h of pathHeadings) {
      const cleaned = stripBackticksFromHeading(h.text);
      const pm = PATH_LINE_HEADING.exec(cleaned);
      if (pm && pm[1]) documentedProductionPaths.push(pm[1]);
      const fence = fenceAfter(body, h.bodyStart);
      if (!fence) {
        findings.push({ level: 'DENY', message: `path:line heading "${cleaned}" has no fenced code block after it` });
      } else if (!fence.content) {
        findings.push({ level: 'DENY', message: `fenced code block under "${cleaned}" is empty` });
      } else if (fence.lineCount > fenceMaxLines) {
        findings.push({ level: 'DENY', message: `fenced code block under "${cleaned}" is ${fence.lineCount} lines, over the ${fenceMaxLines}-line cap` });
      }
    }
  }

  if (diffStats === null) {
    findings.push({ level: 'ADVISE', message: 'cannot measure the diff (no base, or git failed)' });
  } else if (diffStats !== undefined && needsSections) {
    const production = diffStats.filter((d) => !isExempt(d.path, exemptGlobs));
    const undocumented = production.filter((d) => !documentedProductionPaths.some((p) => pathsMatch(p, d.path)));
    if (undocumented.length > 0) {
      findings.push({ level: 'DENY', message: `undocumented production path(s): ${undocumented.map((d) => d.path).join(', ')}` });
    }

    const totalLines = production.reduce((sum, d) => sum + d.added, 0);
    const ceilingVerdict: ReadabilityVerdictKind = asOf >= wordsDenyFrom ? 'DENY' : 'ADVISE';
    if (totalLines > productionCeiling.lines) {
      findings.push({ level: ceilingVerdict, message: `${totalLines} production lines, over the ${productionCeiling.lines}-line ceiling` });
    }
    if (production.length > productionCeiling.files) {
      findings.push({ level: ceilingVerdict, message: `${production.length} files touched, over the ${productionCeiling.files}-file ceiling` });
    }
  }

  const ceilingWords = proseCeilings[surface];
  if (ceilingWords !== undefined) {
    const count = proseWordCount(body);
    if (count > ceilingWords) {
      const level: ReadabilityVerdictKind = asOf >= wordsDenyFrom ? 'DENY' : 'ADVISE';
      findings.push({ level, message: `${count} words of prose, over the ${ceilingWords}-word ceiling for ${surface}` });
    }
  }

  if (findings.length === 0) return finalize('SILENT', []);
  const worst: ReadabilityVerdictKind = findings.some((f) => f.level === 'DENY')
    ? 'DENY'
    : findings.some((f) => f.level === 'ADVISE')
      ? 'ADVISE'
      : 'SILENT';
  return finalize(worst, findings.map((f) => f.message));
}

function finalize(verdict: ReadabilityVerdictKind, messages: string[]): ReadabilityResult {
  const reason = messages.length ? messages.join('; ') : 'no readability issue found';
  if (verdict === 'DENY') {
    return { verdict, reason: `${reason} (set HARNESS_READABILITY_OFF=1 to bypass)` };
  }
  return { verdict, reason };
}

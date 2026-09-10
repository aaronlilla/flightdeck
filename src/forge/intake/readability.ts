/**
 * Readable PR rule (2026-09-09, Aaron): Joe cannot read what the forge writes. This is
 * stream B's half of the shared contract in `__fixtures__/readability.json` (byte-identical
 * copy of `C:/dev/.claude/goals/2026-09-09-readable-pr-rule-specimens/fixtures.json` --
 * stream A implements the same contract against the same file in `authorship_guard.py`).
 * Every constant below is read out of that file rather than re-typed, so the two streams
 * cannot silently drift the way `DEFAULT_MAX_DIFF_LINES` and its three other copies did
 * (see this repo's CLAUDE.md, order 17, on `model_policy.json`).
 *
 * `voiceGuard.comment()` on the Jira write client and the PR-create path in chain/worker
 * both call `readabilityVerdict` before anything reaches a real write -- see `jira.ts` and
 * `chain.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = path.join(__dirname, '__fixtures__', 'readability.json');

interface ReadabilityContract {
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
}

interface FixturesFile {
  contract: ReadabilityContract;
}

const fixtures: FixturesFile = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8'));
const CONTRACT = fixtures.contract;

/** Loaded from the shared fixture, never hand-typed a second time (order 17 parity). */
export const READABILITY_BANNED: string[] = CONTRACT.banned_words;
export const READABILITY_WORDS_DENY_FROM: string = CONTRACT.words_deny_from;
export const PR_EXEMPT_GLOBS: string[] = CONTRACT.exempt_globs;
export const OUTWARD_REPOS: string[] = CONTRACT.outward_repos;
export const TICKET_KEY_REPOS: string[] = CONTRACT.ticket_key_repos;
export const REQUIRED_SECTIONS: string[] = CONTRACT.required_sections;
export const PROSE_CEILINGS: Record<string, number> = CONTRACT.prose_ceiling_words;
export const PRODUCTION_CEILING = CONTRACT.production_ceiling;
export const FENCE_MAX_LINES: number = CONTRACT.fence_max_lines;

const TICKET_KEY_PATTERN = new RegExp(CONTRACT.ticket_key_pattern, 'g');

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

function findBannedWords(text: string): string[] {
  const prose = stripInlineBackticks(stripFences(text));
  const hits: string[] = [];
  for (const word of READABILITY_BANNED) {
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

const EXEMPT_MATCHERS = PR_EXEMPT_GLOBS.map(globToRegExp);

function isExempt(filePath: string): boolean {
  return EXEMPT_MATCHERS.some((re) => re.test(filePath)) || /test/i.test(filePath.split('/').pop() ?? '');
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

  const isJira = surface.startsWith('jira');
  const inScope = isJira || (repo !== null && OUTWARD_REPOS.includes(repo));
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

  if (surface === 'pr-title' && repo && TICKET_KEY_REPOS.includes(repo)) {
    const matches = title.match(TICKET_KEY_PATTERN) ?? [];
    if (matches.length === 0) {
      findings.push({ level: 'DENY', message: 'no ticket key matching BBZ-nnn found in the title' });
    } else if (matches.length > 1) {
      findings.push({ level: 'DENY', message: `expected exactly one ticket key, found ${matches.length}` });
    }
  }

  const bannedHits = findBannedWords(fullText);
  if (bannedHits.length > 0) {
    findings.push({ level: 'DENY', message: `banned word(s) in prose: ${bannedHits.join(', ')}` });
  }

  const needsSections = surface === 'pr-body' || surface === 'jira-description';
  let documentedProductionPaths: string[] = [];
  if (needsSections) {
    const headings = findHeadings(body);
    for (const name of REQUIRED_SECTIONS) {
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
      } else if (fence.lineCount > FENCE_MAX_LINES) {
        findings.push({ level: 'DENY', message: `fenced code block under "${cleaned}" is ${fence.lineCount} lines, over the ${FENCE_MAX_LINES}-line cap` });
      }
    }
  }

  if (diffStats === null) {
    findings.push({ level: 'ADVISE', message: 'cannot measure the diff (no base, or git failed)' });
  } else if (diffStats !== undefined && needsSections) {
    const production = diffStats.filter((d) => !isExempt(d.path));
    const undocumented = production.filter((d) => !documentedProductionPaths.some((p) => p.includes(d.path) || d.path.includes(p)));
    if (undocumented.length > 0) {
      findings.push({ level: 'DENY', message: `undocumented production path(s): ${undocumented.map((d) => d.path).join(', ')}` });
    }

    const totalLines = production.reduce((sum, d) => sum + d.added, 0);
    const ceilingVerdict: ReadabilityVerdictKind = asOf >= READABILITY_WORDS_DENY_FROM ? 'DENY' : 'ADVISE';
    if (totalLines > PRODUCTION_CEILING.lines) {
      findings.push({ level: ceilingVerdict, message: `${totalLines} production lines, over the ${PRODUCTION_CEILING.lines}-line ceiling` });
    }
    if (production.length > PRODUCTION_CEILING.files) {
      findings.push({ level: ceilingVerdict, message: `${production.length} files touched, over the ${PRODUCTION_CEILING.files}-file ceiling` });
    }
  }

  const ceilingWords = PROSE_CEILINGS[surface];
  if (ceilingWords !== undefined) {
    const count = proseWordCount(body);
    if (count > ceilingWords) {
      const level: ReadabilityVerdictKind = asOf >= READABILITY_WORDS_DENY_FROM ? 'DENY' : 'ADVISE';
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

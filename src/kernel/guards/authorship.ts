/**
 * Standing order 13: Aaron is the sole author of everything that ships.
 *
 * The guard denies a tool call that would put a claim of machine authorship
 * somewhere another person can read it. Two paths reach that: a shell command
 * that publishes (a commit, a tag, a pull request, an issue, a release), and a
 * write to a file.
 *
 * Reading is not publishing, which is why a command has to look like a publish
 * before its text is scanned at all. Grepping a repository for a trailer is a
 * perfectly ordinary thing to do.
 *
 * The labels below are worded around the phrases they detect rather than
 * quoting them. This guard's own source has to survive this guard.
 */
import type { Guard, GuardDecision, ToolCall } from '../../types.ts';

const ROBOT = '\u{1F916}';

interface Pattern {
  label: string;
  re: RegExp;
}

/**
 * Claims of machine authorship. Ported from the Python guard, pattern for
 * pattern, because each one was added in response to something that happened.
 */
const ATTRIBUTION: Pattern[] = [
  {
    label: 'a co-author trailer naming a tool',
    re: /co-?authored-by:[^\n]*\b(claude|anthropic|copilot|codex|cursor|chatgpt|openai|gemini|devin|aider)\b/i,
  },
  { label: 'the Anthropic no-reply address', re: /noreply@anthropic\.com/i },
  { label: 'a robot emoji sign-off', re: new RegExp(`${ROBOT}\\s*generated\\s+with`, 'iu') },
  { label: 'a sign-off crediting the tool that produced it', re: /generated\s+with\s+\[?claude(\s+code)?\b/i },
  { label: 'a product attribution link', re: /https?:\/\/claude\.com\/claude-code/i },
  {
    label: 'authorship credited to a machine',
    re: /\b(written|generated|created|authored|produced|implemented|made)\s+(by|with|using)\s+(claude\b|an?\s+ai\b|an?\s+ai\s+agent|chatgpt|copilot|an?\s+llm\b|an?\s+agent\b)/i,
  },
  { label: 'a model referring to itself', re: /\bas\s+an\s+ai\s+(language\s+model|assistant|agent)/i },
  { label: 'a label marking the text as machine produced', re: /\b(ai|agent|assistant)[-\s]generated\b/i },
  { label: 'a label claiming tool assistance', re: /\bai[-\s]assisted\b/i },
  {
    label: 'credit for machine assistance',
    re: /\bwith\s+(the\s+)?(help|assistance)\s+of\s+(claude|an?\s+ai|chatgpt)/i,
  },
];

/** Commands that put text in front of another person. */
const PUBLISH: Pattern[] = [
  { label: 'a commit message', re: /\bgit\s+(-c\s+\S+\s+|-C\s+\S+\s+)*commit\b/i },
  { label: 'a tag message', re: /\bgit\s+(-C\s+\S+\s+)*tag\b[^|;&]*\s-(a|m|s)\b/i },
  { label: 'a git note', re: /\bgit\s+(-C\s+\S+\s+)*notes\b[^|;&]*\b(add|append|edit)\b/i },
  { label: 'a pull request', re: /\bgh\s+pr\s+(create|edit|comment|review)\b/i },
  { label: 'an issue', re: /\bgh\s+issue\s+(create|edit|comment)\b/i },
  { label: 'release notes', re: /\bgh\s+release\s+(create|edit)\b/i },
];

/**
 * Paths where these strings are the subject rather than a credit. The doctrine
 * has to be able to quote what it forbids, and memory files record what was
 * said rather than publish it.
 */
const EXEMPT_FRAGMENTS = ['/.claude/', '/memory/'];
const EXEMPT_BASENAMES = ['claude.md', 'agents.md', 'memory.md', 'error-catalog.csv'];

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function isExemptPath(rawPath: string): boolean {
  const normalized = rawPath.replace(/\\/g, '/').toLowerCase();
  if (normalized.startsWith('.claude/')) return true;
  if (EXEMPT_FRAGMENTS.some((fragment) => normalized.includes(fragment))) return true;
  const basename = normalized.split('/').pop() ?? '';
  return EXEMPT_BASENAMES.includes(basename);
}

export function findAttribution(text: string): Pattern | null {
  if (!text) return null;
  return ATTRIBUTION.find((pattern) => pattern.re.test(text)) ?? null;
}

export function publishKind(command: string): string | null {
  return PUBLISH.find((pattern) => pattern.re.test(command))?.label ?? null;
}

/** The written text a tool call would produce, across the tools that write. */
function writtenText(call: ToolCall): string {
  const input = call.input;
  const parts: string[] = [];
  for (const key of ['content', 'new_string', 'new_source']) {
    const value = input[key];
    if (typeof value === 'string') parts.push(value);
  }
  const edits = input['edits'];
  if (Array.isArray(edits)) {
    for (const item of edits) {
      const value = (item as { new_string?: unknown })?.new_string;
      if (typeof value === 'string') parts.push(value);
    }
  }
  return parts.join('\n');
}

function filePathOf(call: ToolCall): string {
  const input = call.input;
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = input[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

function firstMatchingLine(text: string, re: RegExp): string {
  return text.split(/\r?\n/).find((line) => re.test(line)) ?? '';
}

function denial(label: string, where: string, line: string): GuardDecision {
  return {
    kind: 'deny',
    reason:
      `Machine authorship claimed in text that is about to reach another person.\n\n` +
      `  Found: ${label}\n  In:    ${where}\n  Line:  ${line.trim().slice(0, 160)}\n\n` +
      `Standing order 13: Aaron is the sole author of everything that ships. ` +
      `Rewrite the text in his voice and try again. Adding an exemption is not the fix.`,
  };
}

export const authorshipGuard: Guard = {
  name: 'authorship',

  decide(call: ToolCall): GuardDecision {
    if (call.toolName === 'Bash') {
      const command = typeof call.input['command'] === 'string' ? call.input['command'] : '';
      const kind = publishKind(command);
      if (!kind) return { kind: 'pass' };
      const hit = findAttribution(command);
      if (!hit) return { kind: 'pass' };
      return denial(hit.label, kind, firstMatchingLine(command, hit.re));
    }

    if (WRITE_TOOLS.has(call.toolName)) {
      const path = filePathOf(call);
      if (isExemptPath(path)) return { kind: 'pass' };
      const text = writtenText(call);
      const hit = findAttribution(text);
      if (!hit) return { kind: 'pass' };
      return denial(hit.label, path || call.toolName, firstMatchingLine(text, hit.re));
    }

    return { kind: 'pass' };
  },
};

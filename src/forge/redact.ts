/**
 * One scrub, applied before anything a person or a fix lane reads: a gotcha file, an
 * exec dump, a report row.
 *
 * Verbatim errors are the whole point of a gotcha (paraphrasing makes it unsearchable),
 * but verbatim also means whatever a command printed alongside the error: a token in a
 * URL, a key a misconfigured tool echoed back. This runs on the whole accumulated buffer,
 * never per chunk -- a token split across two stdout reads is still a token, and checking
 * each chunk alone would let half of it through on either side of the split.
 */
const SECRET_PATTERN = /[A-Za-z0-9_-]{24,}/g;

// A git sha is 7 to 40 hex characters. This pattern only matters for the 24-40 end of
// that range -- SECRET_PATTERN never fires on anything shorter than 24 -- but a sha in
// that band is exactly as long as a real token, so it must be told apart on shape (pure
// hex) rather than length alone.
const HEX_SHA = /^[0-9a-fA-F]{7,40}$/;

// A match that starts right after a backslash has swallowed the letter of an escape
// sequence in a JSON document: gh's --json output reaches the council through this
// scrub, and turning backslash-n-BYPASS_EMAIL_VERIFICATION into backslash-[REDACTED]
// made the whole document unparseable (mobile app repository, PR 148, 2026-09-10). Keep
// the escape whole (one letter, or `u` plus four hex digits) and scrub what follows it.
const escapeLength = (match: string): number => (match[0] === 'u' ? 5 : 1);

export function redact(text: string): string {
  if (!text) return text;
  return text.replace(SECRET_PATTERN, (match: string, offset: number, whole: string) => {
    if (HEX_SHA.test(match)) return match;
    if (offset > 0 && whole[offset - 1] === '\\') {
      return match.slice(0, escapeLength(match)) + '[REDACTED]';
    }
    return '[REDACTED]';
  });
}

/** `redact()` applied to every string value in a record, other types left alone. */
export function redactFields<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, typeof value === 'string' ? redact(value) : value]),
  ) as T;
}

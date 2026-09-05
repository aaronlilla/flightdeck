/**
 * Self-write suppression (requirement 4, decision 6): every Jira write Intake makes
 * carries a hidden marker comment with the operation id, and the poller drops an update
 * only when BOTH the author is Aaron's own account (every write goes out in his name,
 * per decision 1) AND the body carries a marker Intake itself wrote. Filtering on author
 * name alone would also swallow Haiping's QA comments, which land on the same account's
 * tickets but must always pass through as real findings (requirement 10).
 */
const MARKER_PREFIX = 'forge-intake-op';

export function markerFor(operationId: string): string {
  return `<!-- ${MARKER_PREFIX}:${operationId} -->`;
}

const MARKER_PATTERN = new RegExp(`\\n?<!-- ${MARKER_PREFIX}:[^>]+ -->`, 'g');

export function withMarker(body: string, operationId: string): string {
  return `${body}\n${markerFor(operationId)}`;
}

export function stripMarker(body: string): string {
  return body.replace(MARKER_PATTERN, '').replace(/\n+$/, '');
}

function hasIntakeMarker(body: string): boolean {
  return new RegExp(`<!-- ${MARKER_PREFIX}:`).test(body);
}

/**
 * True only when both conditions hold. `authorAccount` is the account every Intake write
 * goes out under (decision 1: Aaron's account, Basic auth); a write from that same
 * account with no marker is a genuine human comment and must never be suppressed.
 */
export function isSelfWrite(
  entry: { author: string; body: string },
  authorAccount: string,
): boolean {
  return entry.author === authorAccount && hasIntakeMarker(entry.body);
}

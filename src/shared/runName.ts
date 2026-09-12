/**
 * A run's own name, read out of its id.
 *
 * Aaron, 2026-09-12: "Every board item should be a ticket being worked on, never
 * unnamed, never confusing, never vague."
 *
 * Two lanes on the board both read `Untitled run` on 2026-09-12, so there was no way to
 * tell which `Resume` belonged to which. The board deliberately keeps run ids off the
 * screen, and that was read as leaving nothing to show. It is not: a run id like
 * `2026-09-09-forge-compaction-aware-warden` carries the words somebody wrote when they
 * named the work. Only the date stamp and the product's own name are machine text.
 *
 * So this is not a fallback to the id. It is the words out of the id, with everything
 * that is not words removed -- and it answers `null` when there are none left, so a
 * caller never renders a stripped-empty string.
 */

/** The leading `YYYY-MM-DD` a brief's own id carries. */
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

/** A trailing `-2`, the second attempt at the same brief. */
const ATTEMPT_SUFFIX = /-\d+$/;

/** An id that is a key and not a name: hex, a queue row, a packet. Nothing readable
 *  comes out of these, so they are not guessed at. */
const KEY_SHAPED = /^(?:S-[0-9a-f]{8,}|[0-9a-f]{8,}|Q-[0-9a-f]{6,}|item:.*|queue-.*|jira_.*)$/i;

/**
 * Words that name the product or its parts rather than the work, and mean nothing to
 * somebody reading the board. The same list order 19 keeps out of anything a teammate
 * reads; the screen is held to it too.
 */
const INTERNAL_WORDS = new Set([
  'forge', 'flightdeck', 'astra', 'codex', 'conductor', 'warden', 'lane', 'lanes',
  'harness', 'council', 'refuter', 'lens', 'evaluator', 'goal', 'brief', 'run',
]);

/** Words that are spelled as initialisms rather than capitalised. */
const INITIALISMS = new Map([
  ['pr', 'PR'], ['ci', 'CI'], ['ui', 'UI'], ['ux', 'UX'], ['api', 'API'],
  ['ota', 'OTA'], ['qa', 'QA'], ['db', 'DB'], ['rn', 'RN'],
]);

/**
 * The words in this run id, as a name a person can read, or null when it holds none.
 *
 * `2026-09-09-forge-compaction-aware-warden` -> `Compaction aware`
 * `2026-09-09-readable-pr-rule-flightdeck`   -> `Readable PR rule`
 * `queue-BBZ-169-Q-c578de30`                 -> null (a key, and the ticket names it)
 */
export function runName(id: string): string | null {
  const trimmed = id.trim();
  if (trimmed.length === 0 || KEY_SHAPED.test(trimmed)) return null;
  const slug = trimmed.replace(DATE_PREFIX, '').replace(ATTEMPT_SUFFIX, '');
  const words = slug.split(/[-_\s]+/)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length > 0)
    // A hex chunk inside an otherwise readable slug is a key, not a word.
    .filter((word) => !/^[0-9a-f]{8,}$/.test(word))
    .filter((word) => !INTERNAL_WORDS.has(word));
  if (words.length === 0) return null;
  const spelled = words.map((word) => INITIALISMS.get(word) ?? word);
  const first = spelled[0]!;
  const head = INITIALISMS.has(words[0]!) ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return [head, ...spelled.slice(1)].join(' ');
}

/**
 * Three registers for the stub's own fixtures.
 *
 * The stub server exists so the console can be driven with no fleet behind it, and a
 * console driven that way has to be able to show what the real one shows: the short
 * sentence, the fuller one behind `more`, and the fact record under `?verbose=1`. So a
 * fixture row carries a narration bag the same shape the narrator writes, built here
 * rather than in each fixture file, so the three registers cannot drift apart row by row.
 *
 * `glance` is always the sentence the fixture already had. That is deliberate: the
 * design's artboards draw one register, so a fixture that changed the visible sentence
 * would move `npm run design:parity` for a reason that has nothing to do with design.
 */
import type { NarrationBag } from '../../shared/console-model.js';

/** The moment these fixtures claim to have been narrated. Fixed, never `Date.now()`:
 *  a fixture whose clock moves would photograph differently on every parity run. */
const NARRATED_AT = 1_788_000_000_000;

/** One field's three registers. `facts` becomes the `raw` record, identifiers intact. */
export function registers(
  glance: string,
  detail: string,
  surface: string,
  facts: Record<string, string | number | boolean | null>,
): NarrationBag[string] {
  return { glance, detail, raw: JSON.stringify({ surface, facts }, null, 2), narratedAt: NARRATED_AT };
}

/**
 * A field nobody narrated: three identical registers, no fact record worth showing.
 * Person-authored text in the fixtures goes through here for the same reason the server
 * routes it through `Binder.verbatim` -- so the console cannot render a `more` on a
 * sentence a person typed.
 */
export function verbatim(text: string): NarrationBag[string] {
  return { glance: text, detail: text, raw: text, narratedAt: null };
}

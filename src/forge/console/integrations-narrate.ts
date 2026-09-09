/**
 * The two sentences a data-source row shows: what state it is in, and what that means.
 *
 * They were computed on the client, in `Settings.tsx`, which put them out of the
 * narrator's reach -- a sentence the server never composed is a sentence the model can
 * never rewrite and the checker can never referee. So the words move here and the client
 * renders what it is given.
 *
 * The freshness suffix ("checked four minutes ago") deliberately stays on the client. It
 * is the clock, and the clock is never a narration fact: folding it in would make the
 * cache key move once a second and buy a fresh call for a row that has not changed. The
 * client appends it outside the narrated span, so what a person reads is unchanged.
 */
import type { Integration, NarrationBag, NarrationFacts } from '../../shared/console-model.js';
import { integrationWordsFor } from '../../shared/integration-words.js';

import { Binder } from './narrate-bind.js';
import type { Narrator } from './narrate-store.js';

/**
 * The facts behind a row's two sentences: its state word, how many lanes it stops, and
 * the scope it is checked against. `cause` and `effect` are not facts here -- they are
 * already sentences somebody or something else wrote, and they arrive inside the
 * template, where the checker's template rule holds them.
 */
function factsFor(row: Integration, surface: string, template: string): NarrationFacts {
  const facts: Record<string, string | number | boolean | null> = { status: row.status };
  if (row.dependents.length > 0) facts['blocks'] = row.dependents.length;
  if (row.scope) facts['scope'] = row.scope;
  return { surface, facts: facts as NarrationFacts['facts'], template };
}

/** One row with its registers attached. A row whose probe has never run carries the
 *  `checking` placeholder, which says nothing worth rewriting, so it is left alone. */
export function narrateIntegration(row: Integration, narrator: Narrator | null): Integration {
  if (row.status === 'checking' || row.status === 'busy') return row;
  const bag: NarrationBag = {};
  const binder = new Binder(narrator, 'integrations');
  const status = binder.field(bag, 'status', factsFor(row, 'integration.status', row.words.status), row.id);
  const note = binder.field(bag, 'note', factsFor(row, 'integration.note', row.words.note), row.id);
  const words = {
    status: status ?? row.words.status,
    note: note ?? row.words.note,
  };
  return Object.keys(bag).length > 0 ? { ...row, words, narration: bag } : { ...row, words };
}

export function narrateIntegrations(rows: Integration[], narrator: Narrator | null): Integration[] {
  return rows.map((row) => narrateIntegration(row, narrator));
}

/**
 * The one place a console route turns a fact record into a `Narrated` field.
 *
 * Two methods, and the difference between them is the whole person-text guardrail:
 * `field()` sends facts to the narrator, and `verbatim()` never does. A row a person
 * typed -- an operator's own message, their question, a PR title they wrote -- goes
 * through `verbatim()`, which makes no model call, writes nothing to the narration
 * cache and returns three byte-identical registers. There is deliberately no third
 * method, and no way to hand `field()` a sentence instead of facts, so a route cannot
 * accidentally route person-authored text through the model.
 *
 * The glance register is returned rather than stored, because the caller writes it back
 * onto the object's existing string field: `lane.now` stays a string every existing
 * consumer can read, and it is physically incapable of holding anything but the
 * narrator's glance. `detail` and `raw` live in the object's own `narration` bag, keyed
 * by field name, and are read back through `narratedField`.
 */
import type {
  NarrationBag, NarrationFacts, Narrated,
} from '../../shared/console-model.js';
import type { SliceName } from '../../shared/console-events.js';

import { templateNarration } from './narrate.js';
import { Narrator, passThrough } from './narrate-store.js';

export class Binder {
  constructor(
    private readonly narrator: Narrator | null,
    private readonly slice?: SliceName,
  ) {}

  /** Narrate one field from its facts. Returns the glance to write back onto the
   *  object's own string field, or `null` when the builder had nothing to say. */
  field(bag: NarrationBag, name: string, facts: NarrationFacts | null, ref?: string): string | null {
    if (!facts) return null;
    const narrated: Narrated = this.narrator
      ? this.narrator.get({
        ...facts,
        ...(this.slice ? { slice: this.slice } : {}),
        ...(ref ? { ref } : {}),
      })
      : templateNarration(facts);
    bag[name] = narrated;
    return narrated.glance;
  }

  /** Person-authored text: three identical registers, no model call, no cache key. */
  verbatim(bag: NarrationBag, name: string, text: string | null): string | null {
    if (text === null || text === undefined) return null;
    bag[name] = passThrough(text);
    return text;
  }
}

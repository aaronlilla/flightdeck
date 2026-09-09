import type { JSX } from 'react';

import type { NarrationBag } from '../../shared/console-model.js';
import { narratedField } from '../../shared/console-model.js';

/**
 * One narrated sentence, in whichever register the surface is entitled to.
 *
 * The three registers are not three ways of saying the same thing: `glance` is what a
 * tile shows and is the only register a board ever renders, `detail` is the fuller
 * sentence behind a disclosure on a sheet, and `raw` is the fact record itself, shown
 * only under verbose, where every identifier stays verbatim. Keeping all three in one
 * component is what stops a screen quietly promoting `detail` onto a tile, or `raw`
 * onto a screen a person reads.
 *
 * A field the narrator never touched -- person-authored text, or a console running with
 * `FORGE_NARRATE=off` -- comes back from `narratedField` with all three registers equal,
 * so the disclosure never appears and the sentence is shown exactly as it was written.
 */
export interface NarratedLineProps {
  bag: NarrationBag | undefined;
  field: string;
  glance: string | null;
  /** `?verbose=1`: the fact record under the sentence, identifiers intact. */
  verbose?: boolean;
  testid?: string;
}

export function NarratedLine({ bag, field, glance, verbose, testid }: NarratedLineProps): JSX.Element {
  const narrated = narratedField(bag, field, glance);
  const id = testid ?? field;
  return (
    <>
      <span data-testid={`${id}-glance`}>{narrated.glance}</span>
      {narrated.detail !== narrated.glance ? (
        <details data-testid={`${id}-more`} style={{ display: 'inline' }}>
          <summary style={{ display: 'inline', cursor: 'pointer', color: 'var(--ink2)' }}>more</summary>
          <span data-testid={`${id}-detail`}>{narrated.detail}</span>
        </details>
      ) : null}
      {verbose ? (
        <pre data-testid={`${id}-raw`} style={{ margin: '4px 0 0', color: 'var(--ink2)', whiteSpace: 'pre-wrap' }}>{narrated.raw}</pre>
      ) : null}
    </>
  );
}

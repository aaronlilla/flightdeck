import type { JSX, ReactNode } from 'react';
import { vi } from 'vitest';

import { StoreContext, initialState } from '../../../src/console/store.js';
import type { State } from '../../../src/console/store.js';

/** A store carrying the `links` field `Linkify` reads (the Jira site and the default
 *  repo), so a component under test can render real links. Lifted out of
 *  `linkify.test.tsx`, which had its own copy, once a second test needed it. */
export function withLinks(links: State['links'], children: ReactNode): JSX.Element {
  const state = { ...initialState(), links };
  return <StoreContext.Provider value={{ state, dispatch: vi.fn() }}>{children}</StoreContext.Provider>;
}

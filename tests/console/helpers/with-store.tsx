/**
 * A component test's render, with the console's store around it. Every control that
 * runs a catalog action reads and writes the store (`useAction`), so a component
 * rendered bare throws; this wraps it in a real reducer-backed store rather than a
 * stubbed dispatch, so pending and result state behave as they do in the app.
 */
import type { JSX, ReactElement, ReactNode } from 'react';
import { useReducer } from 'react';
import { render as rtlRender, type RenderOptions, type RenderResult } from '@testing-library/react';

import { initialState, reducer, StoreContext } from '../../../src/console/store.js';

function StoreWrapper({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  return <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>;
}

export function render(ui: ReactElement, options: Omit<RenderOptions, 'wrapper'> = {}): RenderResult {
  return rtlRender(ui, { ...options, wrapper: StoreWrapper });
}

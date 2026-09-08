import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Sweep #21: every clickable `span` across the rail, the tiles, the sheets and the
 * queue cards was mouse-only -- no `role`, no `tabIndex`, no key handling, so a
 * keyboard-only operator could not reach or fire a single one of them. One shared
 * helper, spread onto a `span`, gives it a button's semantics and lets Enter or Space
 * fire the same handler a click would.
 */
/** A minimal event shape a caller's own handler can call `stopPropagation` on -- a
 *  mouse click on a nested actionable span still needs to stop the tile's own click
 *  from also firing, but Enter/Space never produced a DOM click to begin with, so the
 *  synthetic event this passes through for a key press carries no coordinates or
 *  target, only the one thing a caller ever actually used it for. */
export interface ActivateEvent {
  stopPropagation?: () => void;
}

export interface Actionable {
  role: 'button';
  tabIndex: 0;
  onClick: (e?: ActivateEvent) => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
}

export function actionable(onActivate: (e?: ActivateEvent) => void): Actionable {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: (e) => onActivate(e),
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate(e);
      }
    },
  };
}

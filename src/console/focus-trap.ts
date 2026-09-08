/**
 * Sweep #11: a modal sheet had no focus trap -- Tab walked straight off the sheet and
 * onto the covered tiles behind it. `focusableIn` finds every element a sheet's own Tab
 * ring should visit; `trapTab` decides, given the currently focused element and the
 * key event's shift state, which of those two ends of the ring (if either) Tab should
 * wrap onto -- pure, so it is provable without a DOM.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

export function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** Given the ring of focusable elements (first to last) and which one currently has
 *  focus, what Tab (or Shift+Tab) should do: wrap to the far end when focus is about to
 *  leave the ring (including when nothing in the ring is focused at all -- the sheet
 *  just opened, or focus landed somewhere the ring does not track), or `null` when the
 *  browser's own default Tab order already keeps it inside (nothing to override). Takes
 *  the active element as a plain `unknown` rather than reading `document` itself, so
 *  this stays provable with plain objects and no DOM. */
export function trapTab(ring: HTMLElement[], active: unknown, shiftKey: boolean): HTMLElement | null {
  if (ring.length === 0) return null;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  const activeIndex = ring.indexOf(active as HTMLElement);
  if (shiftKey) {
    return activeIndex <= 0 ? last : null;
  }
  return activeIndex === -1 || activeIndex === ring.length - 1 ? first : null;
}

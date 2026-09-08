/**
 * How wide a card is, in one place, for the two grids that lay cards out: the run
 * board (`LanesGrid`) and the queue (`QueueView`).
 *
 * Aaron, 2026-09-08, on the live console: "we only need to be able to fit four cards in
 * a row at maximum screen size ... literally double the width of what they are now".
 * Nine 215px cards fitted in a row on his monitor, and every one of them was too narrow
 * to read.
 *
 * Two floors, and the wider of the two wins at any window size:
 *   - `25%` of the row (less most of the 10px gap) caps the count at four however wide
 *     the window gets, so a bigger monitor buys bigger cards rather than more of them.
 *   - `430px` -- double the old minimum -- is what stops five cramped cards fitting on
 *     a narrow window, where 25% would be small enough to allow them.
 */
export const CARD_MIN_PX = 430;

/** The gap between cards, in px, shared by both grids. */
export const CARD_GAP_PX = 10;

export const BOARD_GRID_COLUMNS =
  `repeat(auto-fill, minmax(max(${CARD_MIN_PX}px, calc(25% - 8px)), 1fr))`;

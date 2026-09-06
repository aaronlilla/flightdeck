/**
 * The one compact renderer for a raw token count, shared by every place the board
 * shows one: the per-run tile, the fleet readout, the cost sheet's headline, the caps
 * form, and the conductor rail's own replies. A bare integer is unreadable at a glance
 * once a run has burned a few hundred thousand tokens, so this renders the board's
 * usual compact register instead: `12.4k`, `847k`, `1.2M`.
 *
 * The cost sheet's own by-step table is the one place that still wants the exact
 * number -- this helper is for glance-readable totals, never for arithmetic.
 */
export function fmtTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1_000) return String(Math.round(n));
  if (abs < 100_000) return `${(n / 1_000).toFixed(1)}k`;
  if (abs < 1_000_000) return `${Math.round(n / 1_000)}k`;
  if (abs < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

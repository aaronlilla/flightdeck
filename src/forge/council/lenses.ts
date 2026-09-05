/**
 * The three lenses Section 5 names: correctness, regression risk, scope/plan conformance.
 * A closed list rather than a bare string, same reasoning as `FORGE_EVENT_NAMES` in
 * contracts.ts -- a caller who wants a fourth lens adds it here first.
 */
export const LENS_NAMES = ['correctness', 'regression-risk', 'scope-conformance'] as const;

export type LensName = (typeof LENS_NAMES)[number];

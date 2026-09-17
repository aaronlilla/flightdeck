/**
 * Item 16, 2026-09-12: the pull request that reached review carried nothing about
 * whether merging publishes an over-the-air update or triggers a rebuild, though the
 * decide job had already resolved `android_action: update`. Whoever merged it could not
 * tell what merging would cost, and the two platforms can differ.
 *
 * The fingerprint is ground truth and this is not, so every sentence says "predicted".
 */
import { describe, expect, it } from 'vitest';

import { shipPredictionFor, renderShipPrediction } from '../../../src/forge/intake/shipPrediction.js';
import { proseWordCount } from '../../../src/forge/intake/readability.js';

describe('shipPredictionFor', () => {
  it('predicts an update on both platforms for a change with no native files', () => {
    const p = shipPredictionFor(['src/features/wallet/screens/WalletScreen.tsx', 'src/app/store.ts']);
    expect(p.android).toBe('update');
    expect(p.ios).toBe('update');
    expect(p.signals).toEqual([]);
  });

  it('predicts an Android rebuild and an iOS update when only android/ moved', () => {
    const p = shipPredictionFor(['android/app/build.gradle', 'src/app/store.ts']);
    expect(p.android).toBe('rebuild');
    expect(p.ios).toBe('update');
    expect(p.signals).toContain('android/app/build.gradle');
  });

  it('predicts an iOS rebuild and an Android update when only ios/ moved', () => {
    const p = shipPredictionFor(['ios/Podfile', 'src/app/store.ts']);
    expect(p.ios).toBe('rebuild');
    expect(p.android).toBe('update');
  });

  // Edge: a patch rewrites a package's own native source, so neither platform can
  // take the change over the air.
  it('predicts a rebuild on both when a patch changed', () => {
    const p = shipPredictionFor(['patches/react-native-svg+15.0.0.patch']);
    expect(p.android).toBe('rebuild');
    expect(p.ios).toBe('rebuild');
  });

  // Edge: a dependency change can pull in native code, and the file list alone cannot
  // say whether it did.
  it('predicts a rebuild on both when the manifest or lockfile changed', () => {
    const p = shipPredictionFor(['package.json']);
    expect(p.android).toBe('rebuild');
    expect(p.ios).toBe('rebuild');
    expect(p.signals).toContain('package.json');
  });

  // Edge: the pull request file query pages at 100, so a full page is a prefix and
  // the absence of a native path in it proves nothing (code review, 2026-09-12).
  it('predicts nothing either way off a truncated file list', () => {
    const files = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`);
    const p = shipPredictionFor(files);
    expect(p.android).toBe('unknown');
    expect(p.ios).toBe('unknown');
  });

  it('still predicts a rebuild off a truncated list, since no unseen file undoes one', () => {
    const files = ['android/app/build.gradle', ...Array.from({ length: 99 }, (_, i) => `src/f${i}.ts`)];
    const p = shipPredictionFor(files);
    expect(p.android).toBe('rebuild');
    expect(p.ios).toBe('update');
  });

  // Edge: nothing to go on. Saying "update" here would be a guess presented as a
  // reading, which is the fault this item exists to remove.
  it('predicts nothing either way when the file list is empty', () => {
    const p = shipPredictionFor([]);
    expect(p.android).toBe('unknown');
    expect(p.ios).toBe('unknown');
  });
});

describe('renderShipPrediction', () => {
  it('names both platforms and says it is a prediction, not the fingerprint', () => {
    const body = renderShipPrediction(shipPredictionFor(['android/app/build.gradle']));
    expect(body).toMatch(/android/i);
    expect(body).toMatch(/ios/i);
    expect(body).toMatch(/predict/i);
    expect(body).toMatch(/fingerprint/i);
  });

  // Found by code review, 2026-09-12: the signal paths went out as plain prose, and
  // every prediction goes through a readability check that DENIES a comment over 80
  // prose words -- so a React Native upgrade or a prebuild regenerating android/ and
  // ios/ refused the comment outright, on exactly the pull requests where rebuild or
  // update matters most. Code in backticks is exempt from the count.
  it('stays well inside the prose ceiling with a hundred signal paths', () => {
    const files = Array.from({ length: 100 }, (_, i) => `android/app/src/f${i}.kt`);
    const body = renderShipPrediction(shipPredictionFor(files));
    // The counter that decides, not a copy of it: a hand-rolled strip counted the
    // separating commas as words and would have failed a comment that passes.
    expect(proseWordCount(body)).toBeLessThan(80);
  });

  it('backticks every signal path', () => {
    const body = renderShipPrediction(shipPredictionFor(['patches/react-native-svg+15.0.0.patch']));
    expect(body).toContain('`patches/react-native-svg+15.0.0.patch`');
  });

  // Found by code review, 2026-09-12: the unknown message said the files could not be
  // read. True when the list was empty, false when 100 were read and the list was a
  // prefix -- a different fact about how much the silence is worth.
  it('says the list was truncated, not that it could not be read', () => {
    const truncated = renderShipPrediction(shipPredictionFor(
      Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`),
    ));
    expect(truncated).toMatch(/first 100|truncated|prefix/i);
    expect(truncated).not.toMatch(/could not read/i);
    expect(renderShipPrediction(shipPredictionFor([]))).toMatch(/could not read/i);
  });

  it('lists the signals it read, so the prediction can be checked', () => {
    const body = renderShipPrediction(shipPredictionFor(['patches/react-native-svg+15.0.0.patch']));
    expect(body).toContain('patches/react-native-svg+15.0.0.patch');
  });

  it('says plainly that it cannot tell when there is nothing to read', () => {
    const body = renderShipPrediction(shipPredictionFor([]));
    expect(body).toMatch(/could not read/i);
    expect(body).not.toMatch(/\bupdate\b/i);
  });
});

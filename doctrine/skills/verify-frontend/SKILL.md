---
name: verify-frontend
description: Mechanism behind standing order 4 (genchi genbutsu) for UI. Fire before presenting ANY change that alters what renders — web, mobile web, or native app — layout, styling, copy, theme, animation, component behavior, or a performance claim. Launch the real app, screenshot real viewports (desktop and TRUE mobile emulation, light and dark), read the console after interaction, guard against stale builds, and report per present-results. Also fires when asked to "check the UI", "make sure it looks right", or confirm a frontend change works.
---

# Verify frontend — the running app is the artifact

Source code is not the artifact. The browser (or device) rendering it
is. Before presenting any change that alters what renders, launch the
real app and look. Looking can only block, never approve — approval
belongs to measurements and the user's eyes (see `present-results`).

## Launch

Use the project's dev command as recorded by `onboard-codebase` in the
project's `.claude/`; if none is recorded, use the built-in `run`
skill. Verify the server actually serves the changed code before
screenshotting anything (staleness guard below).

## Desktop web

- Screenshot at ~1440px width.
- If the app has light AND dark themes, screenshot both. A change
  verified in one theme is unverified in the other.
- If the change animates, also check with `prefers-reduced-motion:
  reduce` — the reduced path is a rendered state like any other.

## Mobile web — sensor-validity caveat (standing order 6)

**Resizing a desktop browser window is NOT device emulation.** A
narrow desktop window (e.g. claude-in-chrome `resize_window`) keeps
desktop DPR, fires no touch events, and sends a desktop UA — media
queries may match while touch targets, hover-dependent UI, DPR-scaled
assets, and UA-sniffed paths go completely unmeasured. The
claude-in-chrome `javascript_tool` runs page-context JS and CANNOT
drive the CDP Emulation domain, so it cannot fix this.

True emulation path — Playwright device profiles:

    npx playwright screenshot --device="iPhone 14" <url> <out.png>

or a Playwright script using `devices['Pixel 7']`. Check ~390px
(phone) and ~768px (tablet/breakpoint boundary).

If only window-resize is available, it may still be used to catch
gross layout breaks — but the report MUST say:
"UNMEASURED: DPR/touch/UA — window resize only." Never present a
resized window as mobile verification.

For what to look for at mobile viewports (safe-area, dvh/svh,
keyboard, input zoom, …), see `mobile-web-quirks`.

## Phone native, from Windows

- **Android:** run on an emulator, capture with
  `adb exec-out screencap -p > shot.png`, then Read the png.
- **Expo / React Native:** `npx expo start` + Expo Go on a physical
  iPhone. The iOS Simulator is macOS-only — NEVER claim iOS verified
  without a physical device in hand. No device = iOS is "Did not look
  at", stated plainly.
- **Flutter:** `flutter run -d <emulator>` + `flutter screenshot`.

## Performance claims need numbers

"Faster" without a number is UNKNOWN, not fine (standing order 1).

    npx lighthouse <url> --form-factor=mobile --throttling.cpuSlowdownMultiplier=4

Good thresholds: INP < 200ms, LCP < 2.5s. Report the measured number
against the threshold; never report the adjective.

## Console and network

Read the console AFTER interacting with the changed surface, not just
on load. Any NEW error or warning introduced by the change is a
headline BLOCKER (standing order 8). Pre-existing noise in a mature
codebase is noted once, not re-litigated. If the change touches data
fetching, check the network panel for failed or duplicated requests.

## Staleness guard

Confirm the dev server actually rebuilt (watch the rebuild output;
hard-reload the page). Pixels suspiciously unchanged after an edit
mean a stale build — treat as broken until proven fresh
(`present-results` rule 6). A screenshot of the old build is worse
than no screenshot: it is a green light on the wrong artifact.

## Report

Per `present-results`: worst finding first; every report states
explicitly "Looked at: X. Did not look at: Y." Never "looks good" —
enumerate what was checked, what was found, and what remains
unmeasured. Looking blocks; it does not approve.

## Minimum evidence by change type

Console read after interaction is mandatory on every row.

| Change type          | Mandatory evidence                          |
|----------------------|---------------------------------------------|
| Layout / structural  | Desktop ~1440 AND mobile ~390, both themes  |
| Copy / text only     | One screenshot of the changed surface       |
| Theme / color        | Both themes, desktop and mobile             |
| Animation            | Its scope's row + reduced-motion screenshot |
| Performance claim    | Lighthouse numbers (INP, LCP) vs thresholds |
| Native mobile        | Per-platform device/emulator screenshot;    |
|                      | platforms without one are "Did not look at" |

Evidence below this table = the change is not presentable as verified.
Present it anyway only with the gap named in the opening lines, never
implied covered.

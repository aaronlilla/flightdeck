---
name: mobile-web-quirks
description: Defect-class registry for mobile web — the failure modes that make a site feel broken on phones. Use when building or reviewing any web UI that phones will reach; when a layout involves 100vh, fixed/sticky bars, modals, bottom sheets, in-page scrollers, forms, or hover-revealed controls; when debugging viewport-height bugs, keyboard overlap, input-focus zoom, scroll bleed-through, tap-highlight flashes, double-tap zoom lag, notch/safe-area clipping, landscape breakage, text autosizing, or tiny tap targets; when adding PWA install or service-worker behavior; and during any verify-frontend pass at mobile viewports — walk this registry as the checklist. Each class gives Symptom / Cause / Fix / Repro.
---

# Mobile-web quirks — defect-class registry

The failure modes that make a site feel broken on phones. This is a
registry, not a tutorial: walk it as the checklist during every
`verify-frontend` pass at mobile viewports, and grep it when a phone bug
report arrives. Each class has four fields — Symptom, Cause, Fix (correct
code), Repro (how to see it fail).

**Repro honesty.** DevTools device emulation cannot produce a soft
keyboard, a collapsing URL bar, iOS focus-zoom, or real safe-area insets.
Where a Repro line says *device only*, emulation green proves nothing for
that class — per the fail-closed order, it reads unverified until a real
phone or simulator has shown it. Say so in the report (`present-results`).

## 1. 100vh overflows under browser chrome

**Symptom.** Bottom of a "full-screen" section — footer, CTA, input bar —
hidden behind the browser's URL bar; page scrolls when it shouldn't.

**Cause.** On mobile, `100vh` equals the *largest* viewport (URL bar
retracted). With the bar visible, the visible area is smaller and the
element overflows it.

**Fix.**
```css
.hero { height: 100vh; height: 100svh; } /* second line wins where supported */
```
Which unit: `svh` (smallest viewport) for anything that must always be
fully visible; `lvh` (largest) for backdrops allowed to extend under
chrome; `dvh` (current, live) only when tracking the bar is worth the
reflow it causes — see class 12.

**Repro.** Device only — emulation never collapses the URL bar. On a real
phone, load with the bar visible and check the element's bottom edge. In
emulation, approximate: any `100vh` on must-be-visible content is a
finding by inspection.

## 2. Notch / home-indicator overlap

**Symptom.** Content or a fixed bar sits under the notch, Dynamic Island,
or home indicator — worst in landscape and standalone PWAs.

**Cause.** `viewport-fit=cover` extends the page into unsafe areas;
without matching `env()` padding, content lands there. Without `cover`,
the insets are all 0 and the page letterboxes instead.

**Fix.**
```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```
```css
.bottom-nav { padding-bottom: env(safe-area-inset-bottom, 0px); }
```

**Repro.** Emulation reports zero insets — device or iOS Simulator only.
To approximate in emulation, temporarily hardcode the padding values and
inspect.

## 3. Fixed/sticky elements jump when the iOS keyboard opens

**Symptom.** Fixed header or bottom bar floats mid-screen, detaches, or
vanishes while the keyboard is up.

**Cause.** The keyboard shrinks the *visual* viewport; `position: fixed`
is anchored to the *layout* viewport, which iOS scrolls out from under it.

**Fix.** Declare intent for engines that honor it, and pin manually on
iOS via `visualViewport`:
```html
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
```
```js
const vv = window.visualViewport;
function pin() { // bar has position:fixed; bottom:0
  bar.style.transform =
    `translateY(-${window.innerHeight - vv.height - vv.offsetTop}px)`;
}
vv.addEventListener('resize', pin);
vv.addEventListener('scroll', pin);
```
`interactive-widget` works on Chrome/Android; iOS Safari ignores it — the
JS path is the iOS fix.

**Repro.** Device only — emulation has no soft keyboard. Focus an input on
a real device or simulator and watch the bar.

## 4. Inputs zoom the page on focus

**Symptom.** iOS Safari zooms the whole page when a field gains focus and
often leaves it zoomed after blur.

**Cause.** iOS auto-zooms any focused control whose computed font-size is
under 16px.

**Fix.** The font-size matrix — 16px at phone widths, smaller allowed
above:
```css
input, select, textarea { font-size: 16px; }
@media (min-width: 768px) {
  input, select, textarea { font-size: 14px; }
}
```
The `maximum-scale=1` hack also suppresses it but disables pinch-zoom on
Android — an accessibility failure. Use the matrix.

**Repro.** The zoom itself is device-only, but the *cause* is measurable
in emulation: audit computed font-size of every focusable control at a
phone viewport — anything under 16px fails.

## 5. Keyboard covers the focused field

**Symptom.** User taps a field in the lower half of the screen; the
keyboard opens on top of it; typing is blind.

**Cause.** Browsers don't reliably scroll the field into the shrunken
visual viewport, especially inside overflow containers or fixed forms.

**Fix.**
```js
visualViewport.addEventListener('resize', () => {
  const el = document.activeElement;
  if (el && el.matches('input, textarea, select'))
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
});
```

**Repro.** Device only. Real device or simulator: tap the bottom-most
field on every form; the field must end up visible above the keyboard.

## 6. Pull-to-refresh and scroll chaining hijack in-app scroll

**Symptom.** Scrolling a drawer, chat log, or list hits its edge and the
page behind starts moving — or Chrome's pull-to-refresh reloads the app
mid-gesture.

**Cause.** Overscroll chains to the parent scroller and then to the
browser's own gestures by default.

**Fix.**
```css
.drawer, .chat-log { overscroll-behavior: contain; }
html, body { overscroll-behavior-y: none; } /* only if the app owns the gesture */
```
Disable browser gestures only where the app genuinely replaces them.

**Repro.** Emulation with touch works: scroll the container to each end
and keep dragging — the page behind must not move; at scrollTop 0 on
Android emulation, drag down and confirm no refresh spinner.

## 7. Gray tap flash

**Symptom.** A gray (iOS) or blue (old Android) rectangle flashes over
elements on tap.

**Cause.** Default `-webkit-tap-highlight-color` on anything clickable.

**Fix.** Remove the flash, then restore feedback — never leave taps mute:
```css
a, button { -webkit-tap-highlight-color: transparent; }
a:active, button:active { opacity: 0.7; }
```

**Repro.** Emulation with touch: press-and-hold links and buttons; no
system highlight, but a visible `:active` change.

## 8. Sluggish scrolling in overflow containers

**Symptom.** An `overflow: auto` pane scrolls without momentum, stutters,
or lags the finger.

**Cause.** Non-passive `touchmove`/`wheel` listeners force the engine to
wait on JS before scrolling; oversized paint areas drop frames.
(`-webkit-overflow-scrolling: touch` is legacy — iOS 13+ gives
subscrollers momentum by default; do not cargo-cult it.)

**Fix.**
```css
.pane { overflow-y: auto; overscroll-behavior: contain; }
.pane > .long-list li { content-visibility: auto; }
```
```js
el.addEventListener('touchmove', onMove, { passive: true });
```

**Repro.** Emulation: Performance panel with 6x CPU throttling,
flick-scroll the pane, look for long tasks and dropped frames; grep the
code for non-passive touch listeners.

## 9. Hover-dependent UI unreachable on touch

**Symptom.** Reveal-on-hover actions, tooltips, and dropdowns can't be
opened on a phone — or the first tap only triggers hover and the second
performs the action.

**Cause.** Touch has no hover; browsers emulate a sticky hover on first
tap.

**Fix.** Hover is an enhancement, never the only path:
```css
.card .actions { opacity: 1; }               /* touch default: visible */
@media (hover: hover) and (pointer: fine) {
  .card .actions { opacity: 0; }             /* hide only where hover exists */
  .card:hover .actions { opacity: 1; }
}
```
Menus and tooltips get a click/tap toggle in JS, not `:hover` alone.

**Repro.** Emulation with touch: every action reachable by hover on
desktop must be reachable by tap; no control may require two taps to
activate.

## 10. Double-tap zoom eats fast taps

**Symptom.** Rapid taps on steppers, counters, or game buttons feel laggy
or zoom the page instead of firing twice.

**Cause.** The browser delays or intercepts taps to detect
double-tap-to-zoom on elements that don't opt out.

**Fix.**
```css
button, .stepper, .tappable { touch-action: manipulation; }
```

**Repro.** Emulation with touch: rapid-tap a +/- stepper ten times; the
counter must advance ten and the page must not zoom.

## 11. Body scroll bleeds behind open modals/sheets

**Symptom.** Scrolling inside a modal also scrolls the page behind it;
closing the modal lands the user somewhere else. iOS ignores
`overflow: hidden` on body.

**Cause.** Touch scrolling chains to the body (class 6), and iOS Safari
doesn't reliably honor body overflow locking.

**Fix.** Position-preserving lock plus contained sheet scroller:
```js
const y = window.scrollY;
document.body.style.cssText =
  `position:fixed; top:${-y}px; left:0; right:0; overflow:hidden;`;
// on close:
document.body.style.cssText = '';
window.scrollTo(0, y);
```
```css
.sheet-scroller { overscroll-behavior: contain; }
```

**Repro.** Emulation with touch: open the modal, drag on the backdrop and
past the sheet's scroll end — background must not move; close and verify
scroll position is exactly where it was.

## 12. URL bar collapse/expand resizes the layout

**Symptom.** Layout jumps mid-scroll as the iOS URL bar hides and shows;
JS-measured heights go stale; `100vh` backgrounds shift.

**Cause.** The viewport height changes during scroll. `window.innerHeight`
cached at load is wrong a moment later.

**Fix.** CSS units over JS measurement — `svh` for anything
layout-critical (never jumps), `dvh` only for overlays meant to track the
bar (class 1). Never cache `innerHeight`; when JS must know, read
`visualViewport.height` inside its `resize` listener.
```css
.hero    { min-height: 100svh; } /* stable */
.overlay { height: 100dvh; }     /* tracks the bar, accepts reflow */
```

**Repro.** Device only for the real bar. In emulation, drag the viewport
height while watching for layout jumps and grep for cached
`innerHeight`/`clientHeight` reads.

## 13. PWA: manifest, iOS standalone, service-worker updates

**Symptom.** No install prompt; iOS home-screen app has a white splash,
wrong status bar, or unsafe-area overlap; users stay on old code forever.

**Cause.** Installability needs a complete manifest (`name`, `start_url`,
`display: standalone`, 192px + 512px icons). iOS has no
`beforeinstallprompt` — install is manual via Share → Add to Home Screen —
and takes its icon, status-bar style, and splash from meta tags, not the
manifest. A new service worker sits in `waiting` until every tab closes.

**Fix.** iOS metas alongside the manifest; detect standalone with
`matchMedia('(display-mode: standalone)')`; surface SW updates instead of
waiting:
```js
navigator.serviceWorker.register('/sw.js').then(reg => {
  reg.addEventListener('updatefound', () => {
    const sw = reg.installing;
    sw.addEventListener('statechange', () => {
      if (sw.state === 'installed' && navigator.serviceWorker.controller)
        showRefreshToast(() => sw.postMessage('SKIP_WAITING')); // sw.js: skipWaiting()
    });
  });
});
```
Status-bar style `black-translucent` puts content under the status bar —
pair it with class 2's safe-area padding.

**Repro.** Lighthouse installability audit; Application panel → Service
Workers with "update on reload" OFF to see the stuck-`waiting` state.
iOS standalone behavior is device/simulator only: actually Add to Home
Screen and launch.

## 14. Landscape: safe areas move, keyboard eats the viewport

**Symptom.** Content clipped at left/right in landscape (the notch side);
forms unusable — the keyboard leaves a strip ~150px tall.

**Cause.** In landscape the safe-area insets shift to left/right, and
landscape height minus keyboard is almost nothing.

**Fix.**
```css
.shell {
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
}
@media (orientation: landscape) and (max-height: 500px) {
  .form { /* compact: one field visible, no fixed chrome */ }
}
```
Classes 3 and 5 apply doubly here.

**Repro.** Rotate the emulated device for layout; insets and
keyboard-in-landscape are device only — rotate a real phone, focus a
field, confirm the field and its submit path stay reachable.

## 15. Text autosizing surprises and tiny tap targets

**Symptom.** Random paragraphs render larger than authored on Android
(font boosting); links and icon buttons too small to hit — and flagged by
Lighthouse and app review.

**Cause.** Text inflation (`text-size-adjust: auto`) on pages the browser
judges non-mobile-optimized; interactive targets under 44px (iOS HIG) /
48dp (Material).

**Fix.**
```css
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
.icon-btn { min-width: 44px; min-height: 44px; }
```
`100%`, never `none` — `none` fights user font settings. Target-size and
spacing tables: `ui-ux-pro-max`.

**Repro.** Emulation: measure every interactive element's hit area at a
phone viewport (Lighthouse flags undersized targets). Font boosting shows
only on real Android — audit for the `text-size-adjust` rule instead.

## Adding a class

When a mobile defect reaches a human that this registry and the checks
missed, that is a test escape — run `escape-procedure`. As part of it,
register the defect here with the same four fields; the Repro line IS the
specimen recipe, written so the next `verify-frontend` pass reproduces it
in one step. A quirk fixed but not registered will escape again on the
next project.

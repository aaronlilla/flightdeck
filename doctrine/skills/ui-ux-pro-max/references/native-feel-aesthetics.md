# Native-Feel Aesthetics — Mechanics That Make Mobile UI Feel Native

Cross-platform "feel layer" for React Native / Expo (concepts port to
SwiftUI/Compose). Platform idioms live in `ios-hig-patterns.md` and
`material3-patterns.md`; this file covers the physics: haptics, springs,
blur, OLED-safe color, sheets, and RN implementation mechanics. Per-style
design systems (Bauhaus … Neumorphism (Mobile)) are rows in
`data/styles.csv` — not duplicated here.

## Haptic Map — One Haptic Per Interaction Class

| Interaction | Haptic (expo-haptics) |
|-------------|----------------------|
| Toggle, tab change, segmented selection | `selectionAsync` or Impact Light |
| Standard button / card tap | Impact Light |
| Primary CTA press, long-press, destructive confirm | Impact Medium |
| Form submit result | Notification Success / Error |
| Bottom-sheet detent snap | Impact Light on each snap |
| Drag crossing a threshold (reorder, swipe-action commit) | Impact Light at the threshold |

Rules: fire on `onPressIn` alongside the visual response, never after the
async result. One haptic per gesture — no chords, no repeats while held.
Mechanical aesthetics (terminal, brutalism) may add Light per "keystroke";
everything else treats haptics as confirmation, not texture.

## Springs & Easing — Motion Tokens

| Motion | Spec |
|--------|------|
| Micro (toggle, press, checkbox) | 150–250ms, `Easing.bezier(0.16, 1, 0.3, 1)` (expo-out) |
| Screen transition | ~400ms, same curve |
| Bottom sheet open/settle | spring `{ damping: 20, stiffness: 90 }` (~500ms) |
| General layout spring | `{ mass: 1, damping: 15, stiffness: 120 }` |
| Playful "squish" release | spring `{ damping: 10 }` — bouncy, use only in toy-like styles |
| Material-feel alternative | `Easing.bezier(0.2, 0, 0, 1)` (M3 emphasized); 100ms switches / 250ms buttons / 400ms modals |

- Press feedback: scale to 0.96–0.97 on `onPressIn`, spring back on
  `onPressOut`. Pair with a state-layer overlay, not a layout shift.
- Entrances: opacity 0→1 + translateY 20→0, staggered 30–50ms per item.
- Brutalist/editorial styles cut instead of fade: instant color inversion,
  ~100–150ms max, no bounce. Pick one motion personality per app.
- Reduced motion: check `AccessibilityInfo.isReduceMotionEnabled` — kill
  marquees, typewriter effects, scanlines, parallax, idle loops; fall back
  to crossfades.

## Blur & Layered Depth

| Surface | Treatment |
|---------|-----------|
| Tab bar / nav header | `BlurView` (expo-blur) `intensity={20}`, `tint="dark"` (or light) — content scrolls under glass chrome |
| Sheet/modal backdrop | Blur or 40–60% black scrim — blur signals "background is dismissible", never decoration |
| Ambient background depth | Vertical gradient (e.g. `#0a0a0f → #020203`) + 1–2 large blurred color "blobs" at ~10–15% opacity, slowly drifting |

Performance law: never animate `blurRadius` on the JS thread. Blobs are
Skia canvases, pre-blurred assets, or native-driver transforms of a
pre-blurred view. Cap blur usage on low-end Android.

## OLED & Dark-Surface Color

| Rule | Do | Don't |
|------|----|-------|
| Screen background | Near-black `#050506` (or `#0a0a0f` family) | Pure `#000000` — causes OLED smearing on scroll (exception: deliberate battery-saver/terminal aesthetic) |
| Background fill | Subtle vertical gradient, optional faint noise to prevent banding | One flat solid color across the whole screen |
| Borders on dark | `rgba(255,255,255,0.06–0.1)` at `StyleSheet.hairlineWidth` | Solid grey borders — they read as dirt on OLED |
| Elevation | Tonal: raise surface lightness per level (`#020203 → #050506 → #0a0a0c`) | Bigger black shadows on dark backgrounds |
| Glow accents | `shadowColor` = accent, opacity 0.2–0.5, offset 0 | Black shadows for emphasis on dark UI |

State-layer opacities (any theme): pressed = 10% black / 15% white overlay
by surface brightness; ghost-button pressed = 12% primary; disabled = 38%
opacity on container and content.

## Sheets Over Modals

- Use a bottom-sheet library (`@gorhom/bottom-sheet`) with detents, drag
  handle, and blurred/dimmed backdrop — not the OS default `Modal`.
  Options land under the thumb; centered modals are for interrupts only.
- Sheet motion: the 500ms spring above; haptic per detent snap;
  swipe-down dismisses; confirm dismiss only when data would be lost.
- Primary CTA lives in the bottom third of the screen (thumb zone),
  full-width, sticky above the home indicator with safe-area padding.

## Transition & Loading Feel

| Moment | Native-feeling choice | Web-feeling mistake |
|--------|----------------------|---------------------|
| Card → detail | Shared-element transition (border/background flow continuously) | Fade to a new screen |
| Scroll on a root screen | Large title collapses into the bar | Fixed header, no response to scroll |
| Loading >300ms | Skeleton/shimmer matching the incoming layout | Centered spinner |
| List updates | Layout animation / Reanimated `entering` | Content popping in place |
| Section-heavy scroll | Sticky section headers that stack | Headers scrolling away |

## RN Implementation Mechanics

- Shadows diverge: iOS `shadow*` vs Android `elevation`. For layered,
  dual (neumorphic), or colored shadows use `react-native-shadow-2` or
  Skia; hard-offset "brutalist" shadows are a solid `View` behind the
  element, shifted on press to simulate the physical click-down.
- Gradient text: `MaskedView` + `LinearGradient`. Gradient fills:
  `react-native-linear-gradient` / `expo-linear-gradient`.
- Text vertical centering in buttons: `includeFontPadding: false`
  (Android).
- Font parity: if the design assumes a platform font (e.g. Roboto),
  bundle it explicitly for the other platform.
- Type scaling: helper `size * windowWidth / 375`; drop display sizes one
  step on SE-class widths so single words don't wrap into nonsense.
- Lists: virtualize anything heavy (`FlashList`/`FlatList`); all motion on
  the UI thread (Reanimated / `useNativeDriver: true`).
- Safe areas: `react-native-safe-area-context` on every screen. Decorative
  backgrounds bleed edge-to-edge under bars; controls never do.
- Touch targets: 44×44pt / 48×48dp minimum — `hitSlop` when the visual is
  smaller (small icons, bracketed text buttons).
- Inputs: semantic `keyboardType` (`email-address`, `phone-pad`,
  `ascii-capable`), `autoCapitalize` per field, focus state changes the
  border/fill — suppress the default platform glow if the style has its
  own focus language.

## Anti-Patterns (Cross-Style)

- No hover assumptions: every interactive element needs a visible pressed
  state; "hover" logic ports to nothing.
- No `#000000` screens outside deliberate OLED-saver styles (see above).
- No default OS `Modal` where a bottom sheet fits.
- No full-opacity grey borders on dark surfaces — always rgba.
- No JS-thread animation of blur, layout, width/height.
- No spinner where a skeleton fits; no skeleton in styles whose language
  is "mechanical" (terminal/mono styles use text progress: `[####--] 60%`).
- No scaled-down desktop layout: if a screen reads as a shrunken website
  (hover-dependent, top-heavy actions, centered modals), it fails the
  native-feel bar.

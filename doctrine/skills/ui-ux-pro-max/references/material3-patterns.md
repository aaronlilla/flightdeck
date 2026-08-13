# Material 3 Patterns — Decision Tables

Reference for Android-native feel (Jetpack Compose, Flutter Material,
React Native on Android). Decide from these tables; don't improvise a
hybrid. iOS equivalents and the full platform-divergence map:
`ios-hig-patterns.md`.

## Dynamic Color

| Situation | Rule |
|-----------|------|
| Android 12+ (API 31+) | Offer wallpaper-derived scheme: `dynamicLightColorScheme` / `dynamicDarkColorScheme` |
| Below API 31 | Fall back to brand-seeded static scheme (same seed → tonal palettes) |
| Strong brand requirement | Static brand scheme is legitimate — but decide it, don't default into it |
| Brand accent inside dynamic scheme | Use for hero moments only; map the rest to scheme roles |
| Any hardcoded hex in composables | Wrong — use `MaterialTheme.colorScheme` roles (primary, surface, onSurface…) |
| Dark theme | Own scheme from the same seed; never inverted light colors; re-check contrast |
| Semantic colors (error/success) | Use `error` role; success/warning as custom extended roles, tokenized |

## Tonal Elevation

Material 3 elevates by tinting the surface with primary, not (only) shadow.

| Level | dp | Typical surfaces |
|-------|----|------------------|
| 0 | 0 | Default background, flush surfaces |
| 1 | 1 | Cards (elevated), search bar at rest |
| 2 | 3 | Bottom sheets, navigation drawer, chips raised |
| 3 | 6 | FAB, top app bar (scrolled), snackbar, menus |
| 4 | 8 | Navigation bar (bottom), dialogs' surface tint |
| 5 | 12 | Dialogs, modal surfaces at the top of the stack |

Rules: pick from this scale only — no ad-hoc dp; `shadowElevation` may
accompany tonal but never replaces the tint; in dark theme tonal elevation
does the separating work shadows can't.

## Navigation Structure

| App structure | Use | Not |
|---------------|-----|-----|
| 3–5 co-equal top-level destinations, phone | Navigation bar (bottom) with icons + labels | Drawer as primary nav |
| 2 destinations | Top-level screens/tabs; a nav bar needs ≥3 | Bottom bar with 2 items |
| 6+ destinations or rarely-visited sections | Navigation drawer (modal on phone) | Cramming 6 into the bottom bar |
| Tablet / landscape / foldable | Navigation rail (left edge); drawer standard on large | Phone bottom bar stretched wide |
| Hierarchy within a destination | Stack navigation + top app bar with up | Nested bottom bars |
| Self-contained task | Full-screen dialog with explicit save/close | Pushing into an unrelated stack |

Drawer-vs-bottom-nav decision: frequency wins — frequent switching →
bottom bar; long tail of sections → bottom bar for the top 4 + drawer or
"More" for the rest. Never both at the same hierarchy level.

Back: system back and predictive back must work everywhere; opt in
(`enableOnBackInvokedCallback`) and never suppress the preview.

## Sheets, Dialogs & Menus

| Situation | Use | Not |
|-----------|-----|-----|
| Contextual choices / actions on phone | Modal bottom sheet with drag handle | Centered dialog with a list |
| Interrupt needing a decision | Basic dialog: title, ≤2 lines, confirm + dismiss | Bottom sheet |
| Complex creation/edit on phone | Full-screen dialog, close (X) + explicit Save | Cramped standard dialog |
| Anchored few-option choice (sort, overflow) | Menu (dropdown) at the anchor | Bottom sheet for 3 tiny options |
| Persistent supplementary content | Standard (non-modal) bottom sheet | Modal sheet the user must dismiss |
| Non-blocking feedback, optionally actionable | Snackbar (with Undo), auto-dismiss | Dialog, Toast for undoable actions |
| Destructive flow | Do-then-undo via snackbar where safe; dialog when irreversible | Silent action, no recovery |

## Top App Bar & FAB

| Situation | Use |
|-----------|-----|
| Root destination screen | Center-aligned or small top app bar; nav icon only if a drawer exists |
| Scrolled content | Pinned bar gains tonal elevation (level 3) or collapses (medium/large → small) |
| Content-first screens (reader, media) | Large/medium collapsing bar, or none |
| One dominant constructive action | FAB (bottom trailing), icon + optional extended label |
| FAB on a screen with a bottom bar | Docked above the bar or use the nav bar's contained FAB slot |
| More than one "primary" action | No second FAB — promote one, demote the rest to the bar/menu |
| Contextual multi-select | Top app bar transforms into contextual action bar with count + actions |

## List Interactions

| Need | Use | Not |
|------|-----|-----|
| Row-scoped quick actions | Swipe with clear affordance, or overflow menu per row | Hidden gestures with no hint |
| Multi-select / bulk edit | Long-press enters selection mode; contextual top bar | iOS-style Edit button |
| Delete | Do-then-undo snackbar where reversible | Confirm dialog for every low-stakes delete |
| Refresh | `PullToRefreshBox` | Refresh icon button as the only path |
| Search within content | Docked search bar → full-screen search view with suggestions | Bare TextField in the app bar |

## Date & Time Pickers (Android)

| Need | Use | Not |
|------|-----|-----|
| Single date | `DatePickerDialog` (Material calendar) with input-mode toggle | iOS-style wheels |
| Date range | Material date range picker (fullscreen) | Two separate single pickers |
| Time | `TimePickerDialog` clock dial, keyboard input toggle | Wheel pickers |
| Known/typed dates (DOB) | Input mode first (text field) | Forcing calendar taps across decades |

## Motion & Native-Feel Rules

| Concern | Rule |
|---------|------|
| Screen-to-screen | Shared-axis or fade-through; `AnimatedContent` with directional spec |
| List → detail | Shared-element (`SharedTransitionLayout`), container transform |
| Press feedback | Ripple (state layer) — never remove without replacement |
| Edge-to-edge | `enableEdgeToEdge()`; content draws behind bars; insets via `WindowInsets` APIs |
| Keyboard | `imePadding()`; input never hidden behind the IME |
| Refresh | `PullToRefreshBox` indicator, not custom drag math |
| Haptics | `LocalHapticFeedback` on long-press and confirmations; sparser than iOS |
| Lists | Stable `key` per item + `animateItem` for reorder/insert |
| Reduced motion | Respect `Settings.Global.ANIMATOR_DURATION_SCALE` = 0 |

## Android Delivery Checklist

- [ ] Dynamic color path AND sub-API-31 fallback both rendered and checked
- [ ] All surfaces on the 0/1/3/6/8/12 dp tonal scale, both themes
- [ ] Predictive back preview works on every screen (nothing suppresses it)
- [ ] Edge-to-edge verified with gesture nav and 3-button nav
- [ ] Snackbar (not Toast) for feedback; Undo offered where destructive
- [ ] Font scale at max and small-width devices don't clip or overlap

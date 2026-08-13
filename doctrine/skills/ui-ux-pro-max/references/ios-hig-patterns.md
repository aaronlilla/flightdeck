# iOS HIG Patterns — Decision Tables

Reference for iOS-native feel (SwiftUI, Flutter Cupertino, React Native on
iOS). Decide from these tables; don't improvise a hybrid. Android
equivalents: `material3-patterns.md`.

## Presenting Actions & Choices

| Situation | Use | Not |
|-----------|-----|-----|
| Confirm a destructive action just triggered | Action sheet (`confirmationDialog`), destructive role red, Cancel last | Alert with Yes/No |
| Secondary actions on a list/grid item | Context menu (long-press) with icons | Visible button row per item |
| 2–6 contextual choices, no content | Action sheet from bottom | Centered custom modal |
| Choice that needs content (form, picker, preview) | Sheet with detents (`.medium` → `.large`) | Full-screen cover |
| Immersive or multi-step task (camera, editor, onboarding) | `fullScreenCover` | Sheet the user can swipe away mid-task |
| Interrupt requiring a decision before anything else | Alert — 2 buttons max, no more than one destructive | Action sheet, banner |
| Non-blocking status ("Saved", "Copied") | Brief overlay/toast-style HUD, auto-dismiss | Alert |
| Item-scoped share | `ShareLink` / system share sheet | Custom share UI |

Sheet rules: drag indicator visible when detents allow resize; tapping scrim
or swiping down dismisses; confirm before dismiss only when data would be
lost (`interactiveDismissDisabled` + confirmation).

## Navigation Idioms

| App structure | Use | Not |
|---------------|-----|-----|
| 2–5 co-equal top-level sections | Tab bar (bottom), always visible | Hamburger drawer — not an iOS idiom |
| Hierarchy within a section | `NavigationStack` push, back at top-left + edge swipe | Modal chains |
| Self-contained task off the main flow | Sheet or full-screen cover with explicit Done/Cancel | Pushing onto the stack |
| 6+ destinations | Tab bar with a "More"/search tab, or flatten IA | Drawer |
| iPad / large width | `NavigationSplitView` (sidebar + detail) | Phone tab bar stretched across |
| Login/paywall gates | Replace root, don't stack | Push with hidden back |

Back behavior: system back + edge swipe must always work on pushed screens;
never override the back button's meaning. State (scroll, input, filters)
survives push/pop.

## Large Title Behavior

| Screen | Title mode |
|--------|-----------|
| Top-level list/feed per tab | Large title, collapses to inline on scroll |
| Detail screens (pushed) | Inline title |
| Sheets and modals | Inline title with Done/Cancel in the bar, or no bar |
| Search-first screens | Large title + `.searchable` (search pulls down under title) |
| Dense tools/settings sub-pages | Inline |

Rules: never pin a large title while content scrolls under it; don't put a
large title on more than the root of a stack.

## Toolbar & Action Placement

| Action | Placement |
|--------|-----------|
| Screen's single primary action | `.primaryAction` (top trailing) — one only |
| Confirm/dismiss on a sheet | `.confirmationAction` / `.cancellationAction` in the sheet's bar |
| Contextual tools during content work | Bottom toolbar (`.bottomBar`) — thumb-reachable |
| Overflow of secondary actions | Trailing menu (ellipsis) — not a row of icons |
| Edit mode on lists | `EditButton` top bar; bulk actions in bottom toolbar while editing |
| Destructive action | Inside a menu or swipe action with `role: .destructive` — never a lone red top-bar button |

## List Interactions

| Need | Use | Not |
|------|-----|-----|
| Row-scoped quick actions | `swipeActions` leading/trailing, full-swipe for the primary one | Buttons crowding each row |
| Delete a row | Trailing swipe with destructive role (+ Edit mode as the discoverable path) | Delete icon per row |
| Multi-select / bulk edit | Edit mode with selection circles, bulk bar at bottom | Long-press checkboxes (Android idiom) |
| Reorder | Edit mode drag handles (`onMove`) | Free-form long-press drag |
| Refresh feed content | `refreshable` (system pull-to-refresh) | Custom refresh button in the bar |
| Load more | Automatic pagination on scroll approach | "Load more" tap targets |

## Date & Time Pickers (iOS)

| Need | Use | Not |
|------|-----|-----|
| Date within nearby range (DOB, filters) | Compact `DatePicker` (tap → calendar popover) | Full calendar always expanded inline |
| Date + time together | Compact picker, date and time segments | Two separate screens |
| Time-only / duration | Wheel style (`.wheel` / countdown) | Calendar grid |
| Date in a bottom sheet flow (Flutter/RN) | Cupertino wheel picker in modal popup | Material calendar dialog on iOS |
| Distant past/future dates | Wheel year access or text entry option | Endless month-by-month swiping |

## Platform-Divergence Map (same feature, both idioms)

| Feature | iOS idiom | Android idiom |
|---------|-----------|---------------|
| Primary navigation | Bottom tab bar | Bottom navigation bar or navigation drawer/rail |
| Back | Top-left back + edge swipe | System back gesture + predictive back preview |
| Secondary item actions | Context menu (long-press), swipe actions | Long-press selection mode, overflow menu |
| Destructive confirm | Action sheet, red destructive role | Dialog or snackbar with Undo |
| Date picker | Wheels / compact calendar popover | Material calendar dialog with input mode |
| Time picker | Wheels | Clock dial with keyboard input toggle |
| Search | `.searchable` under large title, cancel button | Search bar / docked search in top app bar |
| Pull-to-refresh | System spinner above content | Material `PullToRefresh` indicator overlay |
| In-app status feedback | HUD/overlay, no action | Snackbar, optionally with action |
| Undo | Confirm-before-do (action sheet) | Do-then-undo (snackbar) |
| Contextual choices | Action sheet | Modal bottom sheet |
| Settings entry | Tab or profile screen; mirrors Settings app style | Overflow menu or drawer entry |
| Share | System share sheet (`ShareLink`) | Android Sharesheet intent |
| Haptics | Frequent, subtle (selection, success) | Sparser; long-press and confirmations |
| Fonts | SF Pro / SF Rounded, Dynamic Type styles | Roboto / brand type, Material type roles |
| Control shape | Rounded, borderless buttons, grouped lists | Filled/tonal buttons, cards, state layers |
| Switch/toggle | iOS switch, green default | Material switch with icon, themed color |
| Page transition | Right-to-left push with parallax | Fade-through / shared-axis transitions |
| Modality dismissal | Swipe-down on sheets | Back gesture / scrim tap |
| Home affordance clearance | Home-indicator safe area | Gesture nav bar insets (edge-to-edge) |

## Cross-Platform Delivery Checklist

- [ ] Neither platform receives the other's dialogs, pickers, or transitions
- [ ] Edge swipe (iOS) and predictive back (Android) both survive custom gestures
- [ ] Safe areas / insets verified on notched and home-indicator devices
- [ ] Dynamic Type (iOS) and font scale (Android) at max don't break layout
- [ ] One divergence-map row per feature decided consciously, not by default

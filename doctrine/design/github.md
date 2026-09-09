repo: aaronlilla/flightdeck
branch: main
path: src/console

## Last sync
date: 2026-09-09T04:28:36Z

### Updated in this project
- Read the console model, lane tile, blockers view, flight review and humanize rules to ground the redesign's vocabulary and data.
- Copied the brand icon and lockup from brand/.
- Built a fresh Industry-system operator console (not a recreation of the repo UI).

## Screen map
| Screen | Repo files |
| --- | --- |
| Board (1a), Lane sheet (1d) | src/console/components/LaneTile.tsx, LanesGrid.tsx, NeedsYou.tsx, TicketSheet.tsx, src/shared/console-model.ts |
| Blockers (1b) | src/console/components/BlockersView.tsx, src/forge/blockers.ts |
| Queue (1c) | src/console/components/QueueView.tsx |
| Settings (1e) | src/console/components/Settings.tsx |
| Flight review (1f) | src/console/components/FlightReview.tsx |
| Conductor rail (1g), dialogs (1h–1k) | src/console/components/ConductorRail.tsx, src/shared/humanize.ts |
| Chrome | src/console/components/TopBar.tsx, brand/ |

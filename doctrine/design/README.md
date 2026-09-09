# Console design

This folder is the console spec. It is the Claude Design project I edited on 2026-09-08 (https://claude.ai/design/p/45ff120e-e163-4336-91df-5107180d36b8), copied in file for file so the R-16 briefs build to something that lives in the repo.

- `Flightdeck Console.dc.html` is the whole screen at 1440x900. It imports the three parts below.
- `FD Chrome.dc.html` is the window strip and the tab bar (Blockers, Board, Queue, Review, Settings).
- `FD Board.dc.html` is the two-column running grid, then Needs you, Waiting for merge, Blocked or parked, and Finished today.
- `FD Rail.dc.html` is the Conductor rail: status lines, receipts, question cards with options, and the send box.
- `_ds/industry/` is the Industry design system the screens use: Barlow and Barlow Condensed, a light ground, one steel accent, square corners, registration marks. `styles.css` is the token sheet.
- `support.js` is the runtime the `.dc.html` files load. `github.md` is the project's sync record.

Open any `.dc.html` next to `support.js` in a browser to see it. `FD Chrome` points at `brand/flightdeck-icon.png`, which is the repo's `brand/` folder two levels up.

This replaces the IBM Plex night theme for the console. The console code keeps the old look until R-16 lands.

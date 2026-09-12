---
tags: [frontend, mobile, layout]
---
# An emulator cannot see a bottom-chrome bug

A simulator or emulator reports no system navigation inset. A real handset does. So
anything whose correctness depends on the bottom edge of the screen — a button, a footer,
a sticky bar, a scroll view's bottom padding, a tab bar clearance, a safe-area inset —
looks right on an emulator and is wrong on a phone.

This is measured, not assumed. On one layout fix the tester wrote the numbers into the
ticket: 23px of the button exposed on the emulator, 0px on the phone. The emulator was
showing the bug as if it were the fix.

What this means for the run:

- A green emulator check is not evidence about bottom chrome. Never report it as one.
- Anything touching bottom geometry needs a look on a real device before it is called
  verified, and the report says which device.
- If no real device is reachable, say so plainly and hand the visual check to the tester.
  An unmeasured bottom edge reads as broken, never as fine.
- A test that asserts a fixed pixel number for a bottom inset is worthless here, because
  the number is correct on whatever device it was written against and nowhere else. Assert
  that the padding MOVES when the inset moves.

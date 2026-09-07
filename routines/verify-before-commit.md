---
tags: [general, verification]
---
# Run the full check suite before every commit

Run the project's own `verify` script (typecheck, tests, and every project-specific
check it chains) before each commit, not only once at the end of a change. A change
that adds a new source file under a directory a project-specific check scans (an
agnostic-content check, a drift check, a coverage check) can pass every unit test and
still fail that check, and catching it one commit at a time keeps each commit small and
each failure easy to place.

Write the failing test first, watch it fail, then make the smallest change that turns
it green. A check introduced or changed in the same change that is supposed to prove
must itself be proven: break the thing it is meant to catch, confirm the check goes red,
then restore it.

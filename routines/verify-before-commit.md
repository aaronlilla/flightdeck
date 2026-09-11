---
tags: [general, verification]
---
# Run the checks as little as you can get away with

Wall clock is the budget. While you iterate, run only the test files you touched. The
full check suite runs once, at the end, and often not by you at all: the pull request's
own checks run it, so running it before every commit pays for it twice and buys nothing
the gate does not already catch.

A long check is worse than slow, it is fatal to the run. Anything past the 120-second
foreground limit is moved to the background, and a run that ends its turn waiting on one
dies on nudges with its work uncommitted. That is not hypothetical: one ticket wrote its
whole change, passed its own tests, and died that way six times in a row, because the
project's `verify` chains a type check, a lint pass and a full test run at minutes each.

So, in order:

1. Write the failing test first and watch it fail. Make the smallest change that turns
   it green. Run that one file, in the foreground, nothing else.
2. Commit and push as soon as it is green, and open the pull request. A commit is cheap
   and recoverable; an uncommitted tree that dies with the run is gone.
3. Then, once, run the project's own `verify` script and fix what it finds in follow-up
   commits on the same branch. If it cannot finish inside one foreground call, let the
   pull request's checks own it and say so in the body.

Never launch a check in the background and end your turn waiting on it. Block on the
call itself, or do not start it.

A check you introduce or change must itself be proven: break the thing it is meant to
catch, confirm it goes red, then restore it. That costs one short run of one file, and
it is never the thing to skip.

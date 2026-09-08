---
tags: [general, forge, probe]
---
# Finish a forge live-probe ticket without repeating the same eight-step shape

Two separate live-probe tickets ran the identical tool shape:
`Bash>Bash>Bash>Bash>ToolSearch>AskUserQuestion>ToolSearch>forge_done`. Each time, the
`ToolSearch` calls and the `AskUserQuestion` call landed in the middle of the finishing
sequence rather than before it, which is what made the run look four steps longer than
the work was.

Resolve every deferred tool up front, once. If the brief mentions a capability that
needs `ToolSearch` (a specific MCP tool, a task-tracking call, anything not already in
your tool list), call `ToolSearch` for all of it before you touch the
verify/commit/push/PR sequence. Do not discover a missing tool mid sequence and stop to
fetch it: that turns one linear finish into two.

Never ask whether to commit, push, or open the PR. If the brief already states the
branch, the verify command, and "commit, push, open a draft PR, call `forge_done`" as
how the run ends, that is not a decision left open for `AskUserQuestion`. Use
`AskUserQuestion` only for a product or scope question the brief itself does not
answer, per the brief's own "park only for" clause.

The finishing sequence is one pass: run the verify command, commit, push the branch,
open the draft PR, then call `forge_done` with that PR's URL. If verify fails, fix and
re-run; that is the only expected loop back into the sequence.

Collapsing the tool-search and question steps to the front turns the repeated eight-step
shape back into what the brief asked for: verify, commit, push, open PR, done.

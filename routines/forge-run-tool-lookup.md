---
tags: [general]
---
# Resolve deferred tools up front; do not pause on a question the brief already answered

Before doing any other work in a run, look up the schema for every deferred tool the run
will need later, including its own closing call such as `forge_done`, `forge_ask`, or
`forge_handoff`. Use `ToolSearch` once, at the start, for the full set. Discovering a
deferred tool's schema partway through a run, after other work has already started, means
a second `ToolSearch` round trip that the first one could have covered.

Do not call `AskUserQuestion` to check whether to commit, push, or open the draft PR when
the brief already states how the run ends. A brief that spells out its own ending has
nothing left to ask about; asking anyway only adds a pause with no answer to receive.
`AskUserQuestion` is for a real product or scope gap the brief does not resolve, never for
confirmation of a step the brief already decided.

---
name: critique
description: Opt-in adversarial review of the current position by fresh-context agents that have never seen the reasoning behind it. Invoke as /critique before irreversible, expensive, or load-bearing work, when a conclusion feels too clean, when everyone in the conversation already agrees, or when asked to "poke holes in this", "steelman the other side", "what am I missing", or "red team it". Escalation path from earn-convergence clause 6. Never fires on its own — dispatching agents costs tokens and is Aaron's call.
---

# /critique — the fresh-context adversary

Self-critique from inside a conversation has a ceiling: the critic and the
author share a context, so they share the blind spot. Every assumption made
early is invisible by the time it matters, because it stopped looking like an
assumption and started looking like the situation.

This skill spends tokens to buy a second pair of eyes that never saw the
reasoning. An adversary reading the artifacts cold has to reconstruct the case
from what actually exists, which is exactly the test the original reasoning
never gets.

**Never automatic.** Aaron types `/critique`. That invocation IS the request
that satisfies the standing "no subagents unless asked" rule; nothing in this
file authorises dispatching agents at any other time.

## Procedure

1. **Write the target down first.** In two or three sentences: the claim, the
   decision, or the artifact under review, plus where the relevant files are.
   No reasoning, no justification — the adversaries must reconstruct that
   themselves. If they cannot find the case from what is on disk, that is
   already a finding.

2. **Pick the lenses.** One to three agents, each with a DIFFERENT angle.
   Redundant critics agree with each other and prove nothing; diverse ones
   catch failure modes redundancy cannot. Choose from what the target
   deserves:

   - **Correctness** — where is this wrong? Which case breaks it?
   - **Evidence** — which claim is asserted rather than shown? What was
     never actually run or looked at?
   - **Alternatives** — what approach was never considered, and would it have
     been better?
   - **Consequences** — what does this break downstream, six months out, or
     for whoever maintains it next?
   - **Premises** — what is being taken for granted that nobody checked?

3. **Brief each one to REFUTE, not to review.** The prompt says: try to break
   this; default to "it does not hold" when you are uncertain; work from the
   files, not from anyone's summary. A critic asked to "give feedback" writes
   a compliment sandwich. A critic asked to refute goes looking.

4. **Judge what comes back.** Findings are claims, not verdicts — they arrive
   from agents with less context than you, and some will be confidently wrong
   about things you already checked. For each one: is it true, and does it
   change the decision? Verify before repeating it. Dismiss with a reason, not
   a shrug.

5. **Report worst finding first** (`present-results`). If the critique
   surfaced nothing that survives, say so plainly — "three lenses, nothing
   survived verification" is a real and useful result. Do not manufacture a
   finding to justify the tokens, and do not bury a real one because the work
   was nearly finished.

## When it is worth the tokens

Worth it: irreversible actions, anything expensive to undo, work that other
people will build on, a conclusion that arrived suspiciously fast, a plan
where every option happened to point the same way, and any moment where the
conversation has been agreeing with itself for a while.

Not worth it: mechanical edits, work with a fast feedback loop that will tell
you the truth anyway, and anything already covered by a test you are about to
run.

## What this cannot do

A fresh-context agent reading the same repo shares your blind spots ABOUT THE
REPO — a wrong assumption baked into the code is invisible to both of you. It
does not share your blind spots about your reasoning path, which is the whole
point, and it is also the whole limit. Independent context is not independent
ground truth.

The verdict still belongs to measurements and to Aaron's eyes. Surviving a
critique is not a pass; it means one specific way of being wrong was checked
and not found.

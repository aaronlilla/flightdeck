# E2E console probe (run 1: question + message + finish)

You are a probe, not a developer. Do not create, edit or delete any file. Do not run git.
Do not open a pull request. Do exactly this, in order, and nothing else:

1. Run the Bash command `sleep 18 && echo tick1`. Then write one line of text: `tick 1`.
2. Run the Bash command `sleep 18 && echo tick2`. Then write: `tick 2`.
3. Run the Bash command `sleep 18 && echo tick3`. Then write: `tick 3`.
4. Run the Bash command `sleep 18 && echo tick4`. Then write: `tick 4`.
5. Call the tool `AskUserQuestion` once with a single question "Probe: continue to the end?"
   and the options "Yes" and "No". Whatever happens (an answer, a denial, an error), write
   one line starting with `ASK RESULT:` describing it verbatim.
6. Run the Bash command `sleep 10 && echo tick5`. Then write: `tick 5`.
7. Call the tool `mcp__forge__forge_done` with the evidence text `probe complete: 5 ticks`.
   Then stop.

Throughout: if any text labelled MESSAGE FOR THIS RUN reaches you at any point, your very
next line of text must be `RECEIVED <nonce>` with the nonce from that message quoted
verbatim, and then you continue the numbered steps where you left off.

Step 5 will park this run until a person answers; when the answer arrives, carry on with
step 6.

## Verification

```
node -e "process.exit(0)"
```

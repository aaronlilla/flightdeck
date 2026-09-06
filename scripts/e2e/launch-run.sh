#!/usr/bin/env bash
# Adapted from C:/dev/.claude/goals/logs/forge-live-probe-b3.launch.sh for the console
# e2e verification (worktree flightdeck--e2e). Launches one real worker run against a
# throwaway FORGE_HOME, on the fleet login, with the interactive session's CLAUDE_*
# markers stripped so the child starts clean.
set -u
W=${W:-/c/dev/worktrees/flightdeck--e2e}
L=${L:-/c/tmp/forge-e2e-logs}
RUN=${RUN:?set RUN=<slug matching the brief filename>}
BRIEF=${BRIEF:?set BRIEF=<path to the .md brief>}
FORGE_HOME=${FORGE_HOME:?set FORGE_HOME=<throwaway tmpdir>}
CEILING=${CEILING:-40000}
mkdir -p "$L"
cd "$W" || exit 2
echo "launch $(date +%T) run=$RUN brief=$BRIEF home=$FORGE_HOME" > "$L/$RUN.log"
rm -f "$L/$RUN.done"
BEFORE=$(tasklist 2>/dev/null | grep -c "claude.exe")
echo "claude.exe before: $BEFORE" >> "$L/$RUN.log"
FORGE_HOME="$FORGE_HOME" FORGE_CONFIG_DIR=C:/Users/aaron/.claude-fleet \
  env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_PID -u CLAUDE_EFFORT \
      -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDECODE \
      -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u ANTHROPIC_API_KEY \
  npm run forge -- run "$BRIEF" --max-context "$CEILING" \
    "Met when the brief's numbered steps and a forge_done call appear." \
    >> "$L/$RUN.log" 2>&1
echo "exit $?" >> "$L/$RUN.log"
sleep 2
echo "claude.exe after: $(tasklist 2>/dev/null | grep -c claude.exe) (before $BEFORE)" >> "$L/$RUN.log"
date +%T > "$L/$RUN.done"

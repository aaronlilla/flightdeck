#!/usr/bin/env bash
# Adapted from an internal probe-launch script for the console e2e verification.
# Launches one real worker run against a throwaway FORGE_HOME, on the fleet login named
# by FORGE_CONFIG_DIR, with the interactive session's CLAUDE_* markers stripped so the
# child starts clean. Project- and machine-agnostic: the repo checkout, the fleet config
# dir, the throwaway home and the log dir are all read from the environment, never
# hardcoded here.
set -u
W=${FORGE_REPO_DIR:?set FORGE_REPO_DIR=<repo checkout to run from>}
L=${L:-/c/tmp/forge-e2e-logs}
RUN=${RUN:?set RUN=<slug matching the brief filename>}
BRIEF=${BRIEF:?set BRIEF=<path to the .md brief>}
FORGE_HOME=${FORGE_HOME:?set FORGE_HOME=<throwaway tmpdir>}
FORGE_CONFIG_DIR=${FORGE_CONFIG_DIR:?set FORGE_CONFIG_DIR=<fleet login config dir>}
CEILING=${CEILING:-40000}
mkdir -p "$L"
cd "$W" || exit 2
echo "launch $(date +%T) run=$RUN brief=$BRIEF home=$FORGE_HOME" > "$L/$RUN.log"
rm -f "$L/$RUN.done"
BEFORE=$(tasklist 2>/dev/null | grep -c "claude.exe")
echo "claude.exe before: $BEFORE" >> "$L/$RUN.log"
FORGE_HOME="$FORGE_HOME" FORGE_CONFIG_DIR="$FORGE_CONFIG_DIR" \
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

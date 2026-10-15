#!/bin/sh
# Finish the run while repair.ts works through its last repository: one repository's migrations
# take 30 to 60 minutes per commit, and it isn't in the cap recheck. Resumable like run-full.sh.
set -eu
cd "$(dirname "$0")/.."
{
  echo "== cap recheck start $(date -u +%FT%TZ)"
  node study/recheck-cap.ts raw-n1000 25
  echo "== cap recheck done $(date -u +%FT%TZ)"
  node study/repair.ts raw-uncapped 3
  while pgrep -f "study/repair.ts raw-n1000" >/dev/null; do sleep 60; done
  echo "== repair done $(date -u +%FT%TZ)"
  node study/analyze.ts n1000 raw-n1000 raw-uncapped
  echo "== finished $(date -u +%FT%TZ)"
} >> study/private/n1000.log 2>&1

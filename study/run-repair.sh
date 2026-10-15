#!/bin/sh
# After the full run: replay again the commits that failed for an infrastructure reason (see the
# README's Changes), finish the cap recheck, and analyse. Resumable like run-full.sh.
set -eu
cd "$(dirname "$0")/.."
{
  echo "== repair start $(date -u +%FT%TZ)"
  node study/repair.ts raw-n1000 3
  node study/recheck-cap.ts raw-n1000 25
  echo "== cap recheck done $(date -u +%FT%TZ)"
  node study/repair.ts raw-uncapped 3
  node study/analyze.ts n1000 raw-n1000 raw-uncapped
  echo "== finished $(date -u +%FT%TZ)"
} >> study/private/n1000.log 2>&1

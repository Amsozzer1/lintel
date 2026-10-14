#!/bin/sh
# The full run: screening to N=1000, replay (3 in parallel), cap recheck on 25 over-cap
# repositories, analysis. Every step resumes where it stopped: rerun the same command after a crash.
# Started under `caffeinate -ims` so the Mac doesn't sleep. Logs go to study/private/n1000.log.
set -eu
cd "$(dirname "$0")/.."
{
  echo "== start $(date -u +%FT%TZ)"
  node study/sample.ts 1000
  echo "== screening done $(date -u +%FT%TZ)"
  node study/replay.ts 3 --out raw-n1000
  echo "== replay done $(date -u +%FT%TZ)"
  node study/recheck-cap.ts raw-n1000 25
  echo "== cap recheck done $(date -u +%FT%TZ)"
  node study/analyze.ts n1000 raw-n1000 raw-uncapped
  echo "== finished $(date -u +%FT%TZ)"
} >> study/private/n1000.log 2>&1

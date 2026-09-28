# Lintel GitHub Action

Replays your base branch's and your pull request's Supabase migrations into two throwaway databases, checks both, and fails only on findings the PR **introduces**.

It uses two workflows so that no code from a pull request (including one from a fork) ever runs with a write token.

## 1. Check (`.github/workflows/lintel.yml`)

```yaml
name: lintel
on:
  pull_request:
    paths: [supabase/**]
permissions:
  contents: read
jobs:
  lintel:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0          # the base commit must be available
      - uses: Amsozzer1/lintel/action@main
        with:
          supabase-dir: supabase  # default
          fail-on: error          # default
```

## 2. Comment (`.github/workflows/lintel-comment.yml`)

Copy [this repository's `lintel-comment.yml`](../.github/workflows/lintel-comment.yml). It:

- runs on `workflow_run`, so it has a write token but never checks out PR code;
- confirms the findings belong to the PR's current head commit, which skips stale runs and forged PR numbers;
- renders the comment with trusted code, escaping every identifier;
- updates one sticky comment in place, including "fixed in this PR".

GitHub only runs `workflow_run` workflows from the default branch, so merge this file before you expect comments.

## What runs where

| | Check job | Comment job |
|---|---|---|
| Trigger | `pull_request` | `workflow_run` |
| Token | read-only | `pull-requests: write` |
| Runs PR code | migrations only, in throwaway containers | never |
| Lintel built from | the action's pinned source | the default branch |

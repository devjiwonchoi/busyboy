# ALIGN: Add a health endpoint

Version: 1 · Status: approved by test-user on 2026-11-14

# Goal

`GET /health` answers with the service status.

# Success criteria

## 1 · The endpoint answers
- Check: auto
- Proven by: `requesting /health should return ok`

# Todos

## 1 · Health route        (subagent)
- Goal: `/health` returns `{ ok: true }`.
- Done when: the journey passes.

## 2 · Deliver        (subagent)
- Goal: a PR is open.
- Done when: CI passes.

# ALIGN: Show API health in the footer

Version: 2 · Status: approved by test-user on 2026-11-14

Builds on: api/add-health-endpoint-d4e5f6

# Goal

The footer shows whether the API is healthy.

# Success criteria

## 1 · The footer shows the status
- Check: auto
- Proven by: `opening the page should show the API status`

## 2 · A failing API shows as down
- Check: auto
- Proven by: `a failing health check should show down`

# Todos

## 1 · Footer component        (subagent)
- Goal: the footer has a status slot.
- Done when: it renders.

## 2 · Fetch the status        (subagent)
- Goal: the footer reads `/health` from the API.
- Done when: both journeys pass.

## 3 · Deliver        (subagent)
- Goal: a PR is open.
- Done when: CI passes.

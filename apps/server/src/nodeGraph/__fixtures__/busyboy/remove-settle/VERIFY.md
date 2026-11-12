# Verify: remove thread settlement

Checked revision: branch `remove-settle`, base `main` @ 1bdec31d, uncommitted working tree (215 files, ~+1.1k/−9.2k; new: server `threadSnooze.ts(+test)`, `ProjectionShellReads.test.ts`, migration `002_RewriteThreadSettlementEvents.ts`). Baseline worktree: /private/tmp/claude-501/busyboy-main-check.

## Criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| No settle feature code left | pass | identifier grep (settledOverride, settledAt, unsettledAt, autoSettle*, thread.settle*, runOnSettle, threadSettlement, settled shelf, lastSnoozeWakeAt, thread-settled, …) returns only migration/keybinding-retirement/back-compat tests |
| All packages typecheck | pass | `pnpm typecheck` (20/20 packages, no errors) |
| Old data still loads | pass | migration 002 + `Migrations.test.ts` decode test (server agent); contracts test decodes settings with removed keys; mobile `storage.test.ts` drops retired pref; keybindings tests drop retired `thread.settle` and keep default sync |
| Tests | pass (pre-existing failures only) | contracts 622/622; client-runtime 1878/1878; provider-core 193/193; web unit 6522/6522; web browser: 108 files pass in batches (agent), sidebar pointer 30/30 after my hover fix; shared 1 fail `nodeSqliteClient` (fails on main); mobile 2 native Swift files fail (fail on main); server: see below |
| Formatting | pass | `vp fmt --check` on changed files: only `serverSettings.test.ts`, `Sidebar.logic.test.ts` flagged, both also flagged on main |
| Lint | pass | new warnings vs main fixed (unused import in threadSort.ts, unused const in mobile threadListV2.test.ts) |


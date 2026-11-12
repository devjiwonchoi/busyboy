# ALIGN: Bring computer use and the in-app browser into BusyBoy clean-room style

Version: 2 · Status: approved by user on 2026-11-04

# Goal

Design computer use and the in-app browser clean-room style and add them to BusyBoy.

---

# End state

## File tree

```text
.jwn/clean-room/handoff/SPEC-computer-use.md          # NEW
.jwn/clean-room/handoff/SPEC-browser.md               # NEW
.jwn/clean-room/handoff/RULES.md                      # NEW
.jwn/clean-room/HANDOFF-LOG.md                        # NEW
native/computer-use/Cargo.toml                        # NEW
native/computer-use/crates/protocol/                  # NEW
native/computer-use/crates/core/                      # NEW
native/computer-use/crates/macos/                     # NEW
native/computer-use/crates/helper/                    # NEW
native/computer-use/THIRD_PARTY_NOTICES.md            # NEW
apps/desktop/scripts/build-computer-use.mjs           # NEW
apps/desktop/src/computerUse/ComputerUseHelper.ts     # NEW
apps/desktop/src/computerUse/ComputerUseClient.ts     # NEW
apps/desktop/src/computerUse/ComputerUseOverlay.ts    # NEW
apps/desktop/src/backend/DesktopBackendConfiguration.ts # MODIFIED
packages/contracts/src/desktopComputerUse.ts          # NEW
packages/contracts/src/settings.ts                    # MODIFIED
apps/server/src/computerUse/ComputerUseChannel.ts     # NEW
apps/server/src/mcp/toolkits/computerUse/             # NEW
apps/server/src/mcp/McpInvocationContext.ts           # MODIFIED
apps/server/src/orchestration-v2/ProviderSessionManager.ts # MODIFIED
apps/web/src/components/chat/ComputerUseAppRequestCard.tsx # NEW
apps/web/src/components/settings/ComputerUseSettings.tsx   # NEW
scripts/build-desktop-release.ts                      # MODIFIED
scripts/dev-runner.ts                                 # MODIFIED
apps/desktop/src/preview/history/BrowsingHistory.ts   # NEW
apps/desktop/src/preview/history/AddressBarSuggestions.ts # NEW
apps/desktop/src/preview/passwords/PasswordStore.ts   # NEW
apps/desktop/src/preview/passwords/PasswordFill.ts    # NEW
apps/desktop/src/preview/passwords/ChromePasswordImport.ts # NEW
apps/desktop/src/preview/PasswordFormPreload.ts       # NEW
apps/desktop/src/preview-pick-preload.ts              # MODIFIED
apps/desktop/src/ipc/methods/preview.ts               # MODIFIED
packages/contracts/src/browserHistory.ts              # NEW
packages/contracts/src/browserPasswords.ts            # NEW
apps/web/src/components/preview/AddressBarSuggestionList.tsx # NEW
apps/web/src/components/preview/PreviewChromeRow.tsx  # MODIFIED
apps/web/src/components/preview/PasswordSavePrompt.tsx # NEW
apps/web/src/components/settings/BrowsingHistorySettings.tsx # NEW
apps/web/src/components/settings/PasswordManagerSettings.tsx # NEW
apps/web/src/browserHistoryStore.ts                   # DELETED
apps/web/src/components/preview/PreviewEmptyState.tsx # MODIFIED
apps/server/src/preview/ServerBrowserPage.ts          # MODIFIED
apps/server/src/mcp/toolkits/preview/tools.ts         # MODIFIED
apps/web/src/components/chat/BrowserSignInCard.tsx    # NEW
apps/web/src/components/chat/BrowserHistoryRequestCard.tsx # NEW
```

---

# Success criteria

## 1 · Keep spec and every PR diff free of OpenAI code, wording and internal identifiers

- Met by: todo 1
- Proven by: The contamination check reports zero hits in the spec, handoff answers and each PR diff

## 2 · Ship computer use off by default

- Met by: todo 2
- Proven by: Covered by tests and an end-to-end run

## 3 · Attach macOS permissions to the helper, not BusyBoy

- Met by: todo 3
- Proven by: Covered by tests and an end-to-end run

## 4 · Reject unverified callers

- Met by: todo 4
- Proven by: Covered by tests and an end-to-end run

## 5 · Read app state without moving focus

- Met by: todo 5
- Proven by: Covered by tests and an end-to-end run

## 6 · Work without screen recording permission

- Met by: todo 6
- Proven by: Covered by tests and an end-to-end run

## 7 · Operate approved apps without moving the cursor or focus

- Met by: todo 7
- Proven by: Covered by tests and an end-to-end run

## 8 · Show app approval cards and a blocklist

- Met by: todo 8
- Proven by: Covered by tests and an end-to-end run

## 9 · Stop at once on Escape, user input or another client's stop

- Met by: todo 9
- Proven by: Covered by tests and an end-to-end run

## 10 · Refuse on the lock screen

- Met by: todo 10
- Proven by: Covered by tests and an end-to-end run

## 11 · Keep a Rust core that a Windows backend can plug into

- Met by: todo 11
- Proven by: Covered by tests and an end-to-end run

## 12 · Offer background coordinate clicks as an option

- Met by: todo 12
- Proven by: Covered by tests and an end-to-end run

## 13 · Store and manage visit history

- Met by: todo 13
- Proven by: Covered by tests and an end-to-end run

## 14 · Suggest pages in the address bar

- Met by: todo 14
- Proven by: Covered by tests and an end-to-end run

## 15 · Store passwords encrypted

- Met by: todo 15
- Proven by: Covered by tests and an end-to-end run

## 16 · Save and fill sign-ins

- Met by: todo 16
- Proven by: Covered by tests and an end-to-end run

## 17 · Never expose credentials to agents

- Met by: todo 17
- Proven by: Covered by tests and an end-to-end run

## 18 · Import passwords from Chrome

- Met by: todo 18
- Proven by: Covered by tests and an end-to-end run

## 19 · Put both PR stacks up for review

- Met by: todo 19
- Proven by: Covered by tests and an end-to-end run

## 20 · Confirm completeness by black-box comparison

- Met by: todo 20
- Proven by: Covered by tests and an end-to-end run

# Human checkpoints

1. macOS permissions: cleared by the user.

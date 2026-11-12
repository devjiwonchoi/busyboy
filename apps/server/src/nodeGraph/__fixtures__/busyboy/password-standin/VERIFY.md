# Verify — agent sign-in fills a stand-in, swaps the real password in at the network layer

## 2026-10-27: PASSED at password-import fd96ee69 + uncommitted diff (sha1 of `git diff` 2d404c06f006, plus untracked PasswordSubstitution.ts/.test.ts)

Criteria and evidence:
1. Page never receives the real password during an agent sign-in. Evidence: PasswordSignIn.test "puts only a stand-in in the page" asserts that no script run in the page contains the password. Real Electron 44 window: the page's own input listener saw only the stand-in.
2. The sign-in request to the page's origin carries the real password. Evidence: real Electron run: a form POST arrived as `pw=fake+%22pw%22+1`, and a JSON fetch arrived as `{"password":"fake \"pw\" 1"}`.
3. Swaps go only into one body sent to the page's own origin. They never go into URLs, other origins, or a second request. Evidence: PasswordSubstitution.test (5/5).
4. Pages where the swap can't happen report `unsupported` and clear the field. Evidence: PasswordSignIn.test, with TestClock moved past 15 s.
5. Interception doesn't cancel the rewritten request. Found in the real Electron run (Fetch.disable right after continue caused "Failed to fetch"). Fixed by keeping interception on 10 s after the swap, then rechecked in Electron.
- Typecheck: desktop, contracts and server all exit 0. Lint is clean and the touched files are formatted.
- Tests run (changed only): PasswordSubstitution 5, PasswordSignIn 7, DesktopBrowserHost 6.

Gaps:
- Not exercised inside the full Busyboy dev app with an agent driving preview_sign_in. The CDP mechanics were checked in plain Electron with the same module.
- Sites that hash or encrypt the password in JS, send it through a service worker, or post it to a different origin get `unsupported` (by design).

# ALIGN: Computer Use와 내장 브라우저를 클린룸 방식으로 BusyBoy에 도입

Version: 2 · Status: approved by user on 2026-11-04 ("ㅇㅇ 진행해")

# Goal

Computer Use와 내장 브라우저를 클린룸 방식으로 도입합니다.

---

# End state

## File tree

```text
.jwn/clean-room/handoff/SPEC-computer-use.md          # NEW (커밋 안 함): CU 동작 사양서 + 인수 기준 + 공개 참고 지도
.jwn/clean-room/handoff/SPEC-browser.md               # NEW (커밋 안 함): 브라우저 동작 사양서 + 인수 기준 + 공개 참고 지도
.jwn/clean-room/handoff/RULES.md                      # NEW (커밋 안 함): 금지 목록, 질의 절차
.jwn/clean-room/HANDOFF-LOG.md                        # NEW (커밋 안 함): 핸드오프·질의응답 기록
native/computer-use/Cargo.toml                        # NEW: Rust 작업 공간
native/computer-use/crates/protocol/                  # NEW: 플랫폼 무관 JSON-RPC 타입
native/computer-use/crates/core/                      # NEW: 세션, 요소 참조, 정책 훅, Platform 트레이트
native/computer-use/crates/macos/                     # NEW: AX 트리·동작, pid 키 입력, SCK 창 캡처, 이벤트 탭, 잠금 감지, 호출자 서명 확인
native/computer-use/crates/helper/                    # NEW: 소켓 서버, 책임 분리 재실행, .app 진입점
native/computer-use/THIRD_PARTY_NOTICES.md            # NEW: agent-desktop·cua·Peekaboo 출처 고지
apps/desktop/scripts/build-computer-use.mjs           # NEW: cargo 빌드 → .app 번들 → 서명
apps/desktop/src/computerUse/ComputerUseHelper.ts     # NEW: 고정 경로 복사, 감독, 권한 상태
apps/desktop/src/computerUse/ComputerUseClient.ts     # NEW: 헬퍼 소켓 클라이언트
apps/desktop/src/computerUse/ComputerUseOverlay.ts    # NEW: 사용 중 오버레이
apps/desktop/src/backend/DesktopBackendConfiguration.ts # MODIFIED: 데스크톱↔서버 채널
packages/contracts/src/desktopComputerUse.ts          # NEW: 메시지·도구 스키마·오류 코드
packages/contracts/src/settings.ts                    # MODIFIED: CU·브라우저 설정
apps/server/src/computerUse/ComputerUseChannel.ts     # NEW
apps/server/src/mcp/toolkits/computerUse/             # NEW: computer_* 도구, 승인 정책, 금지 목록
apps/server/src/mcp/McpInvocationContext.ts           # MODIFIED: capability
apps/server/src/orchestration-v2/ProviderSessionManager.ts # MODIFIED: 도구 노출
apps/web/src/components/chat/ComputerUseAppRequestCard.tsx # NEW
apps/web/src/components/settings/ComputerUseSettings.tsx   # NEW
scripts/build-desktop-release.ts                      # MODIFIED: 헬퍼 번들·서명
scripts/dev-runner.ts                                 # MODIFIED: 개발 시 헬퍼 빌드
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
apps/web/src/browserHistoryStore.ts                   # DELETED: 새 저장소로 이전 후 삭제
apps/web/src/components/preview/PreviewEmptyState.tsx # MODIFIED
apps/server/src/preview/ServerBrowserPage.ts          # MODIFIED: 자격증명 칸 값 제거 확대
apps/server/src/mcp/toolkits/preview/tools.ts         # MODIFIED: preview_history, preview_sign_in
apps/web/src/components/chat/BrowserSignInCard.tsx    # NEW
apps/web/src/components/chat/BrowserHistoryRequestCard.tsx # NEW
```

---

# Success criteria

## 1 · 사양서와 모든 PR diff에 OpenAI 코드·문구·내부 식별자가 없게 하기

- Met by: 0a, 0b, 0c, C6, B7
- Proven by: 오염 검사 스크립트가 사양서, 핸드오프 답변, 각 PR diff에서 0건을 보고함

## 2 · Computer Use 기본 꺼짐

- Met by: C3
- Proven by: 설정이 꺼져 있으면 `computer_*` 도구가 목록에 없고 헬퍼 프로세스가 뜨지 않음 (테스트 + `ps`)

## 3 · macOS 권한을 BusyBoy가 아닌 헬퍼에 붙이기

- Met by: C1, C2
- Proven by: `codesign -dv`에 팀 `TEAMID0000`가 나오고, 손쉬운 사용 설정에 "BusyBoy Computer Use" 항목이 있음 (E2E, 사용자 확인)

## 4 · 확인되지 않은 호출자 거부

- Met by: C1
- Proven by: 다른 팀·무서명 바이너리 연결은 거부되고 BusyBoy 프로세스는 통과함 (Rust 통합 테스트)

## 5 · 포커스를 바꾸지 않고 앱 상태 읽기

- Met by: C1–C3
- Proven by: TextEdit에 `computer_snapshot`를 호출하면 요소 참조가 있는 트리를 돌려주고, 맨 앞 앱은 그대로임 (E2E)

## 6 · 화면 기록 권한 없이 동작

- Met by: C1, C3
- Proven by: 권한이 없어도 읽기·동작이 되고, 스크린샷 필드는 이유와 함께 생략됨

## 7 · 승인된 앱을 커서·포커스 이동 없이 조작

- Met by: C1, C3
- Proven by: 다른 앱이 맨 앞인 상태에서 TextEdit 클릭·입력·값 설정·키 입력 후 커서 위치와 맨 앞 앱이 그대로임 (E2E)

## 8 · 앱 승인 카드와 금지 목록

- Met by: C3
- Proven by: 승인 옵션별 동작 (테스트 + E2E), 금지 앱은 카드 없이 `app_forbidden`

## 9 · Esc·사용자 개입·다른 클라이언트의 중지로 즉시 멈춤

- Met by: C4
- Proven by: 동작 중 오버레이가 보이고, Esc·마우스 개입·웹 중지 버튼 모두 1초 안에 동작 취소와 턴 중단 (E2E)

## 10 · 잠금 화면에서 거부

- Met by: C1, C3
- Proven by: 잠금 상태 테스트에서 `screen_locked`, grep으로 인증 플러그인·authorizationdb·잠금 해제 코드 없음

## 11 · Windows 백엔드를 붙일 수 있는 Rust 코어

- Met by: C1
- Proven by: `cargo check -p protocol -p core --target x86_64-pc-windows-msvc` 통과

## 12 · 배경 좌표 클릭 옵션

- Met by: C5
- Proven by: 기본 꺼짐. 켜면 Chromium 기반 앱에 커서 변화 없이 클릭이 전달됨 (E2E)

## 13 · 방문 기록 저장과 관리

- Met by: B1
- Proven by: SQLite 기록, 시크릿 미기록, 에이전트 표시, 설정 검색·삭제·기간 지우기, localStorage 이전 (테스트 + E2E)

## 14 · 주소창 제안

- Met by: B2
- Proven by: 기록·자주 가는 사이트·검색 제안, 인라인 완성, 제안 삭제. 원격 제안이 꺼져 있으면 네트워크 요청 없음 (테스트 + E2E)

## 15 · 비밀번호 암호화 저장

- Met by: B3
- Proven by: DB 파일에 평문 없음 (테스트), 관리 화면 목록·편집·삭제, 보기에 Touch ID (E2E)

## 16 · 로그인 저장과 채우기

- Met by: B4
- Proven by: 제출 후 저장 프롬프트, 다음 방문 시 Touch ID 후 채움, 시크릿에서는 둘 다 없음 (로컬 테스트 로그인 페이지 E2E)

## 17 · 에이전트에 자격증명 비노출

- Met by: B5
- Proven by: 스냅샷·evaluate에서 로그인 칸 값이 비어 있음 (테스트), 로그인 카드는 모델에 상태만 전달, 방문 기록 조회 시 승인 카드 (E2E)

## 18 · Chrome에서 비밀번호 가져오기

- Met by: B6
- Proven by: 픽스처 Login Data 가져오기 테스트 통과. 실제 Chrome 가져오기는 사용자가 키체인 허용 후 개수 일치 (E2E, 사용자 단계)

## 19 · 두 PR 스택을 리뷰 대기 상태로 올리기

- Met by: C6, B7, 2
- Proven by: PR별로 건드린 패키지의 테스트·typecheck·lint 통과, PR 11개 리뷰 대기·스레드 연결·Moniterate review-ready

## 20 · 블랙박스 비교로 완성도 확인

- Met by: 2
- Proven by: CU·브라우저 핵심 시나리오를 ChatGPT와 비교한 결과표가 HANDOFF-LOG에 있고, 차이마다 해결 또는 의도한 차이로 기록됨

---

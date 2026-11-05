# PM 태스크 보드 레퍼런스: 여러 에이전트 작업을 한 화면에 보여주는 방법

- 작성일: 2026-11-05
- 작성: 태스크 #18 task lead
- 목적: BusyBoy PM 화면을 "긴 채팅 하나"에서 **모든 태스크가 한눈에 보이는 Linear식 보드**로 바꾸기 위해, 여러 AI 에이전트 작업을 동시에 보여주는 제품과 OSS를 조사한다. 사용자는 보드에서 진행 상황을 보면서, 아무것도 막지 않고 태스크나 플랜을 열어 대화하고, 질문에 답하고, 승인할 수 있어야 한다.
- 관련 문서: [always-on-agents.md](./always-on-agents.md) (branch `t3/0f716ab6`, Gas Town과 agent-orchestrator 소스 분석)
- 표기: 출처는 1차 자료(공식 문서, changelog, 공식 블로그, 저장소)다. 1차 자료로 확인하지 못한 내용은 **(미검증)**으로 표시했다. 저장소 인용은 `SHA:파일:줄` 형식이다.

## 0. 요약 (TL;DR)

- **BusyBoy와 구조가 가장 비슷한 제품은 둘이다.**
  - **Claude Code Projects**: 코디네이터 대화가 하나 있고, 태스크마다 thread(브랜치와 PR이 따로)가 있다.
  - **Factory Workstreams**: 왼쪽에 orchestrator 채팅, 오른쪽에 상태별로 묶인 Agents 탭이 있다.
  - 두 제품 모두 **코디네이터 채팅 옆에 상태별로 묶은 에이전트 목록**을 두고, 목록의 어느 에이전트든 **직접 열어 대화**할 수 있다.
- **목록은 "나에게 필요한 것" 순으로 묶는다.** 제품마다 "Waiting on you", "Needs input", "Blocked", "Needs Attention" 그룹을 맨 위에 둔다. 조사한 거의 모든 제품이 이 패턴을 쓴다.
  - Claude Projects, Claude agent view, Factory, Devin, Vibe Kanban, Sculptor, Jean, Sidecar, Codex Micro.
- **질문과 승인은 질문이 생긴 태스크 안에서 답한다.** 목록에는 배지, 점, 손 아이콘만 띄운다.
  - Claude Projects는 문서에 **코디네이터에게 "진행해"라고 말해도 thread의 승인 프롬프트에 닿지 않는다**고 명시한다.
  - 목록에서 바로 답하는 "peek"도 있다. Claude agent view에서는 Space를 누른 뒤 번호로 답한다.
- **진짜 칸반은 드물다.** 칸반은 Vibe Kanban, Nimbalyst, Jean 정도다.
  - 칸반을 쓰는 제품은 **수명주기 열(column)과 실시간 상태 배지를 분리**한다. 예를 들어 Nimbalyst는 열을 Planning/Implementing으로 나누고, running/waiting/unread는 카드 배지로 보여준다.
  - Vibe Kanban의 최신 보드는 카드에 실시간 상태를 빼서 계획용 화면이 됐다. 피해야 할 사례다.
- **PR이 최종 리뷰 화면이다.** 카드의 PR 배지(open/merged, CI 색)와 PR 이벤트가 열 이동(In review → Done)을 자동으로 일으킨다.
- **BusyBoy 권고**(§4):
  1. PM 화면을 "PM 채팅 + 보드" 2단으로 나눈다.
  2. 보드의 열은 task stage, 배지는 실시간 상태로 쓰고, "Needs you"를 맨 위에 고정한다.
  3. 결정 카드는 해당 태스크 카드와 peek에서 바로 답하게 한다.
  4. 태스크를 열면 lead 스레드가 옆 패널에 뜨고, 거기서 보낸 메시지는 PM을 거치지 않는다.
  5. sitrep은 보드의 변화 요약으로 줄인다.

---

## 1. 제품별 조사

각 절의 순서: **개요(목록/보드)** → **상세(클릭하면 보이는 것)** → **사람 개입(질문·승인·PR 리뷰)** → **코디네이터 대 단일 에이전트** → **스크린샷**.

### 1.1 Linear: 에이전트에게 위임한 issue

**개요**
- 별도 보드가 없고 **Linear 자체가 보드**다. 에이전트는 워크스페이스 사용자처럼 @멘션하고 할당할 수 있으며, 유료 좌석을 차지하지 않는다 ([agents](https://linear.app/developers/agents)).
- **delegate와 assignee를 나눈다.** 에이전트에게 할당하면 `delegate`로 들어가고, 사람은 assignee로 남는다. 에이전트는 "사용자를 대신해 일하는 contributor"다 ([changelog 2025-07-30](https://linear.app/changelog/2025-07-30-agent-interaction-guidelines-and-sdk)).
- **에이전트 작업 전체 보기**
  - 위임한 issue는 My issues에 그대로 보인다.
  - custom view와 Insights에 **Delegate 필터**가 있다.
  - 에이전트마다 활동 페이지가 있다 ([agents-in-linear](https://linear.app/docs/agents-in-linear), [Copilot changelog](https://linear.app/changelog/2025-10-28-github-copilot-agent)).
- **상태 연동**: 에이전트가 작업을 시작하면 issue를 팀의 첫 "started" 상태로 옮기라고 권고한다. 자동화로 위임된 issue는 triage에 둔다 ([agent-best-practices](https://linear.app/developers/agent-best-practices)).

**상세**
- issue 안에 **Agent Session**이 붙는다.
  - 상태: `pending | active | awaitingInput | error | complete | stale`.
  - **상태는 에이전트가 정하지 않는다.** Linear가 마지막 activity를 보고 정한다.
  - 헤더의 **Open** 버튼은 에이전트의 외부 URL(자체 대시보드, PR)로 간다 ([agent-interaction](https://linear.app/developers/agent-interaction)).
- **Activity 종류**
  - `thought`, `action`(도구 호출과 결과), `elicitation`(질문), `response`(완료), `error`가 있고, 사용자 메시지는 `prompt`다.
  - `thought`와 `action`은 ephemeral로 보낼 수 있다. 다음 activity가 오면 사라진다.
- **Plan**(technology preview): 세션 단위 체크리스트다. 단계마다 `pending | inProgress | completed | canceled` 상태가 있고, 갱신할 때마다 목록 전체를 보낸다.
- **시간 규칙**: 첫 activity는 10초 안에 와야 하고, 그러지 않으면 unresponsive로 표시된다. 30분 동안 activity가 없으면 `stale`이 된다 ([agent-best-practices](https://linear.app/developers/agent-best-practices)).

**사람 개입**
- 질문은 **issue 안에 inline으로** 뜬다. `response`, `elicitation`, `error`는 issue 코멘트 스레드에도 자동으로 복제된다.
- **signal** ([agent-signals](https://linear.app/developers/agent-signals))
  - `select`: 선택지가 있는 elicitation이다. 사용자가 고르거나 직접 입력한다. 선택지가 버튼으로 렌더링되는지는 **(미검증)**.
  - `auth`: 계정 연결 패널이다.
  - `stop`: 드롭다운의 "Send stop request"로 보낸다.
- 알림: "에이전트가 입력이 필요하거나 리뷰 준비가 되면 알린다" ([Copilot changelog](https://linear.app/changelog/2025-10-28-github-copilot-agent)).
- PR 리뷰
  - 외부 에이전트는 GitHub PR에서 리뷰한다.
  - Linear 자체 coding sessions(2026-06-11)는 issue 옆 Diffs 탭에서 리뷰하고 바로 머지한다. 세션은 multiplayer라 누구나 따라가고, 방향을 바꾸고, 넘겨받을 수 있다 ([coding-sessions](https://linear.app/coding-sessions), [now/coding-sessions](https://linear.app/now/coding-sessions-for-linear-agent)).

**코디네이터 대 단일 에이전트**: issue 하나에 세션 하나다. 여러 세션을 아우르는 코디네이터는 없고, 전체 보기는 일반 Linear view에 Delegate 필터를 건 것이다.

**스크린샷**
- [assignee 메뉴의 에이전트 목록](https://webassets.linear.app/images/ornj730p/production/68c955d01e0e45b23747e8cd7362b018b06a6655-2880x1768.png)
- [Agent Session 헤더](https://webassets.linear.app/images/ornj730p/production/0c5bc5681df359df62ea9520ff05403eafa4f020-2114x306.png)
- [activity 데모 영상](https://webassets.linear.app/files/ornj730p/production/41b5d7ff8f2c38b270844c9e6ac56c34eeea9cd0.mp4)
- [Cursor가 Linear에 남긴 activity](https://cursor.com/docs-static/images/integrations/linear/linear-activity.png)

### 1.2 GitHub Copilot coding agent, Agent HQ / mission control

**개요**
- **Agents panel**(2025-08-19): github.com 헤더의 Agents 버튼으로 어느 페이지에서나 여는 오버레이다.
  - 최근 태스크와 실시간 상태를 보여주고, 클릭하면 PR로 간다.
  - "View all tasks"를 누르면 전체 페이지(github.com/copilot/agents)가 열린다 ([changelog](https://github.blog/changelog/2025-08-19-agents-panel-launch-copilot-coding-agent-tasks-anywhere-on-github-com/)).
  - 상태 값의 종류는 **(미검증)**.
- **Agent HQ / mission control**(Universe, 2025-10-28): GitHub, VS Code, 모바일, CLI를 아우르는 "unified command center"다. 여러 회사의 에이전트를 함대처럼 배정하고 병렬로 추적한다 ([welcome-home-agents](https://github.blog/news-insights/company-news/welcome-home-agents/), [how-to](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/)). 공식 스크린샷은 찾지 못했다.
- **지금 세션이 보이는 곳**: Agents panel, github.com/copilot 홈, 저장소별 Agents 탭, 모바일, CLI, 그리고 데스크톱 앱 사이드바(저장소별로 묶음) ([manage-and-track-agents](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents), [agent-sessions](https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions)).

**상세**
- **세션 로그 뷰어**: 진행 상황, 토큰, 시간, 추론, 사용한 도구가 나온다. 로그 아래 입력창으로 **steering**한다. 메시지는 현재 도구 호출이 끝난 뒤 반영된다. 외부 에이전트는 steering을 지원하지 않는다.
- **Stop session**은 Actions 실행을 끝내고 이미 push된 커밋은 남긴다. 커밋마다 세션 로그 링크가 붙는다.
- 세션 모드는 Interactive, Plan(플랜 승인), Autopilot이다. 도구 권한은 Ask every time, Assisted, Approve all 중에서 고른다.

**사람 개입**
- **PR이 리뷰 화면이다.** 작업이 끝나면 Copilot이 사용자를 reviewer로 추가하고, 사용자는 PR 코멘트에 `@copilot`으로 반복 요청한다 ([use-cloud-agent-on-github](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github)).
- **CI 승인은 PR merge box에 뜬다.** Copilot의 push로는 Actions가 돌지 않는다. 사람이 "Approve and run workflows"를 눌러야 실행된다 ([reviewing-a-pull-request](https://docs.github.com/copilot/how-tos/agents/copilot-coding-agent/reviewing-a-pull-request-created-by-copilot)). 2026-03-13부터 관리자가 이 승인을 끌 수 있다 ([changelog](https://github.blog/changelog/2026-03-13-optionally-skip-approval-for-copilot-coding-agent-actions-workflows/)).
- Copilot은 자기 PR을 승인하거나 머지할 수 없다.
- GitHub 알림과 리뷰 요청 외에 별도 "needs you" inbox는 찾지 못했다 **(미검증)**.

**코디네이터 대 단일 에이전트**: 세션을 하나씩 steering한다. mission control은 목록과 실행기일 뿐 코디네이터 에이전트가 아니다.

**스크린샷**: [Agents panel](https://github.blog/wp-content/uploads/2025/08/Agents-panel-with-callout-2.png)

### 1.3 OpenAI Codex cloud, Codex 앱

openai.com과 help.openai.com은 403으로 막혀서 현재 문서(learn.chatgpt.com)와 오픈소스 TUI 코드로 확인했다.

**개요**
- 현재 문서는 클라우드 제품을 **"Codex Cloud (Legacy)"**로 표기한다.
  - 흐름: 환경 선택 → 태스크 시작(태스크마다 별도 workspace) → 변경과 테스트 결과 리뷰 → follow-up → commit 또는 PR ([cloud](https://learn.chatgpt.com/docs/cloud)).
  - 출시일(2025-05-16 research preview)은 검색 결과로만 확인했다 **(미검증)**.
- **태스크 목록**
  - `codex cloud list`의 필드는 `id, url, title, status, updated_at, environment_label, summary, is_review, attempt_total`이다 ([developer-commands](https://learn.chatgpt.com/docs/developer-commands)).
  - 오픈소스 cloud-tasks TUI는 한 행을 `[STATUS] 제목` / `환경 • 상대 시간` / `+추가/−삭제 • N files`로 그린다. 상태 값은 READY, PENDING, APPLIED, ERROR다 ([codex-rs/cloud-tasks](https://github.com/openai/codex/tree/main/codex-rs/cloud-tasks) `src/ui.rs`).
  - 웹 목록의 레이아웃은 **(미검증)**.

**상세**
- **best-of-N**: `--attempts 1-4`로 시도 횟수를 정한다. TUI 상세 화면 구성:
  - Conversation 탭과 Diff 탭.
  - "Attempt i/N" 전환기. 시도마다 Completed, Failed, In progress, Pending, Cancelled 상태가 따로 있다.
  - "Apply Changes?" 모달. 충돌과 건너뛴 경로를 보여준다.
- 웹의 "Create PR" 버튼과 시도 나란히 비교는 2차 자료에만 있다 **(미검증)**.
- **Codex 데스크톱 앱**: git worktree 위에서 채팅을 병렬로 돌린다. 헤더의 Hand off로 Local과 Worktree 사이를 오가고, 거기서 commit, push, PR을 한다 ([git-worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees.md)).

**사람 개입**
- **Activity 뷰**: 사이드바 종 아이콘을 누르면 "unread, running, waiting for your response" 채팅이 모인다. 턴 완료, 권한 요청, 질문마다 OS 알림을 따로 켜고 끈다 ([notifications](https://learn.chatgpt.com/docs/notifications.md)).
- **Codex Micro**(하드웨어 키보드): Agent Key 6개가 채팅 하나씩을 따라가고, 키 색으로 상태를 보여준다 ([codex-micro](https://learn.chatgpt.com/docs/features/codex-micro.md)).
  - 흰색은 idle, 파란색은 thinking, 초록색은 완료·안 읽음, 호박색은 입력 필요, 빨간색은 오류다.
  - Approve와 Decline 전용 키가 있다.
  - "Priority chats" 모드는 입력 대기, 안 읽음, 실행 중 순으로 앞에 놓는다. 상태를 어떻게 분류하는지 가장 압축해서 보여준다.
- CLI 승인 오버레이에는 **어느 thread가 묻는지**(source thread label)가 표시된다.
- iOS에서는 follow-up이 기본으로 실행 중인 태스크를 **steer**한다(2026-11-02, [changelog](https://learn.chatgpt.com/docs/changelog)).

**코디네이터 대 단일 에이전트**
- 클라우드 태스크는 각각 독립이다.
- 앱에서는 main chat이 subagent를 만든다. "각 subagent thread를 보여줘서 작업과 main chat에 돌아온 요약을 확인할 수 있다." steering이나 중단은 main chat에 요청한다.
- IDE는 composer 위에 실행 중인 subagent를 상태와 "stop all"과 함께 보여준다 ([llms-full.txt](https://learn.chatgpt.com/docs/llms-full.txt) subagents 절).

### 1.4 Claude Code: 웹, 데스크톱, agent view, Projects

**개요**
- **클라우드 세션**(2025-10-20 "Claude Code on the web"으로 출시): claude.ai/code 사이드바에 세션이 나열된다. 태스크마다 세션, VM, 브랜치가 따로 있다 ([news](https://www.anthropic.com/news/claude-code-on-the-web), [docs](https://code.claude.com/docs/en/claude-code-on-the-web)).
- **데스크톱**
  - 사이드바에 세션 목록과 "Group and sort"가 있다.
  - Option-클릭은 split view, Cmd-클릭은 새 창이다.
  - 세션마다 Worktree 토글이 있다.
  - 보고 있지 않은 세션이 끝나면 OS 알림이 온다 ([desktop](https://code.claude.com/docs/en/desktop)).
- **agent view**(`claude agents`, research preview) ([agent-view](https://code.claude.com/docs/en/agent-view))
  - 그룹 순서: **Pinned → Ready for review → Needs input → Working → Completed**. Ctrl+S로 디렉터리별 묶기로 바꾼다.
  - 행 구성: 상태 아이콘, 이름, **최근 활동이나 지금 묻는 질문**, 경과 시간, PR 배지 `#N`. PR 배지 색은 노랑(검사·리뷰 대기), 초록(통과), 보라(머지), 회색(draft/closed)이다.
  - 터미널 탭 제목에 "2 awaiting input"이 뜨고, `s:blocked` 필터가 있다.
- **Claude Code Projects**(공개 베타, Pro/Max/Ultra) ([claude-projects](https://code.claude.com/docs/en/claude-projects))
  - **코디네이터 대화** 하나가 오래 실행된다. 코디네이터는 "thread가 보고한 것을 보고, 매 단계를 보지는 않는다."
  - 태스크마다 **thread**(브랜치와 PR이 따로 있는 클라우드 세션)가 생긴다. thread는 사용자 메시지 아래에 제목과 상태가 있는 **카드**로 뜬다.
  - 카드의 다음 행동 버튼: Resolve conflicts, Fix CI, Address comments, Merge it, Review PR, Create PR.
  - **Overview 패널**의 Threads 탭은 thread를 **Ready for review / Waiting on you / Working / Landing / Idle / Resolved**로 묶는다. Waiting on you에는 답·승인 대기와 실패가 들어가고, Landing은 PR 승인 또는 머지 대기다. 다른 탭은 Library, Pull requests, Scheduled tasks다.
  - thread가 사용자를 기다리면 Overview 버튼에 점이 뜬다. 코디네이터 게시, thread 오류, 입력 필요 때 데스크톱 알림이 온다.

**상세**
- **클라우드 세션 페이지**: 채팅 옆 "session rail"에 Changes 카드(`+42 -18`)가 있다. 누르면 diff 뷰가 열리고, 줄 코멘트를 달면 다음 메시지에 묶여 간다. Create PR(우클릭은 draft)이 있고, PR을 만든 뒤에도 세션이 살아 있어 CI와 리뷰 코멘트를 auto-fix할 수 있다 ([web-quickstart](https://code.claude.com/docs/en/web-quickstart)).
- **teleport**: `claude --teleport`로 클라우드 세션의 브랜치와 대화를 터미널로 가져온다. `claude -p "msg" --cloud <id>`는 실행 중인 세션에 follow-up을 큐에 넣는다.
- **agent view peek**
  - **Space**를 누르면 최신 출력이나 대기 중인 질문이 peek 패널에 뜬다.
  - **목록을 떠나지 않고** 객관식은 번호로, 주관식은 텍스트로 답한다.
  - 권한 다이얼로그는 세션에 attach(→)해야 답할 수 있다.
- **Projects의 thread 열기**: Overview 패널에 transcript가 열린다. 거기 입력창으로 steer하거나, 권한 프롬프트에 답하거나, Stop한다.
  - "거기서 보낸 메시지는 그 thread로 바로 간다. project 대화의 follow-up은 Claude가 그 thread와 맞다고 판단할 때만 전달된다."

**사람 개입**
- **승인은 코디네이터를 거칠 수 없다.** "프롬프트는 그 thread 안에 있다… project 대화에서 Claude에게 진행하라고 말해도 그 프롬프트에 닿지 않는다" ([claude-projects](https://code.claude.com/docs/en/claude-projects)).
- 클라우드 권한 모드는 Auto, Accept edits, Plan이다. 자리를 비운 사이 질문이 오면 환경이 만료되기 전까지 나중에 답할 수 있다.
- 데스크톱은 "Allow for this session / Deny"를 세션 안에 inline으로 띄운다.

**코디네이터 대 단일 에이전트**: **둘 다 된다.** 코디네이터와 thread의 모델 설정이 따로 있다(기본값: 코디네이터 low effort, thread high effort). 비교: [agents](https://code.claude.com/docs/en/agents)(subagents, agent view, agent teams, workflows, Projects).

**스크린샷**
- [agent view](https://mintcdn.com/claude-code/HDAmBwgbrZVk0pOt/images/agent-view-light.png?fit=max&auto=format&n=HDAmBwgbrZVk0pOt&q=85&s=d6905012bee31f3e6b3920b09c05dd02)
- [Projects 구조도](https://mintcdn.com/claude-code/e8CLbxM17eD7cAiv/images/claude-projects-overview.svg?fit=max&auto=format&n=e8CLbxM17eD7cAiv&q=85&s=dbf446f69f0bbdb9961d21af207cb93b)

### 1.5 Cursor: Cloud Agents(구 Background Agents), Agents Window

**개요**
- **Cursor 2.0**(2025-10-29): "에이전트와 플랜을 위한 사이드바". 프롬프트 하나로 최대 8개 에이전트를 병렬로 돌리고, 각 에이전트는 별도 worktree나 원격 머신에서 실행된다 ([changelog/2-0](https://cursor.com/changelog/2-0)).
- **Cursor 3**(2026-04-02) Agents Window: 로컬, worktree, 클라우드, SSH 에이전트를 **사이드바 하나에** 모은다. 모바일, 웹, Slack, GitHub, Linear에서 시작한 에이전트도 포함된다 ([changelog/3-0](https://cursor.com/changelog/3-0), [blog/cursor-3](https://cursor.com/blog/cursor-3)).
- **Cursor 3.1**: 화면을 타일로 나눠 여러 에이전트를 나란히 띄운다. 드래그로 배치하고, 레이아웃이 유지된다 ([changelog/3-1](https://cursor.com/changelog/3-1)).
- **그 뒤 사이드바 변화** ([release-notes](https://cursor.com/docs/release-notes))
  - 행을 **한 줄로** 줄이고 마지막 갱신 시각을 붙였다.
  - pin과 archive가 생겼다. Pinned, Repositories, Workspaces, Chats 헤더를 접을 수 있다(3.27).
  - 탭에 hover하면 사이드바와 같은 에이전트 카드가 뜬다(3.24).
  - 안 읽은 thread가 있으면 프로젝트 행에 불이 들어온다(3.24).
  - 메뉴 막대에 안 읽은 에이전트 개수가 뜬다(3.27).
- Error 그룹, Today/Last 7 days 묶기는 **(미검증)**.

**상세**
- 에이전트별 채팅과 diff가 있고, diff 뷰에서 stage, commit, PR까지 한다. 클라우드 에이전트는 스크린샷, 영상, 로그를 첨부한 "merge-ready PR"을 만들고, 원격 데스크톱을 넘겨받을 수도 있다 ([cloud-agent](https://cursor.com/docs/cloud-agent)).
- 플랜은 사이드바에 있다. 세션은 클라우드와 로컬 사이를 오간다.

**사람 개입**
- 질문과 승인은 **에이전트 채팅 안에 inline으로** 뜬다(release notes 3.24 "Approval, error, and branch mismatch prompts").
- subagent가 입력을 기다리면 상태줄에 "Waiting for approval"이나 "Waiting for response"가 뜬다(3.25).
- 알림
  - 행마다 unread 표시가 붙는다.
  - Cursor가 포커스를 잃었을 때 멈춘 에이전트 전체를 묶어 시스템 알림 하나만 보낸다(3.26).
  - 완료 chime은 클라우드에서 코디네이터 턴만 울린다(3.24).
- Linear 연동: 에이전트 상태가 Linear에 실시간으로 보이고, Linear에서 답하면 follow-up으로 전달된다 ([integrations/linear](https://cursor.com/docs/integrations/linear)).

**코디네이터 대 단일 에이전트**: 대부분 에이전트를 하나씩 상대한다. subagent와 `/multitask`가 있다(세부는 **미검증**, [forum](https://forum.cursor.com/t/multitask-in-agents-window/158955)). PR 페이지에서는 idle 부모 헤더가 일하는 자식들을 "Waiting on"으로 보여준다. 사이드바 전체를 관리하는 PM형 코디네이터는 문서에 없다.

**스크린샷**
- [2.0 Plan Mode](https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/changelog/changelog-2-0-0.png)
- [Agents Window](https://cursor.com/docs-static/images/agent/file-agents-window-final.png) (상대 경로로 조립한 URL)

### 1.6 Devin (Cognition)

**개요**
- **Devin 2.0**(2025-04-03): 병렬 Devin을 여러 개 띄우고, 각자 클라우드 IDE를 쓴다. "Devin이 필요할 때 사용자를 불러들인다" ([blog/devin-2](https://cognition.com/blog/devin-2)).
- **세션 사이드바**: 2026년 내내 다듬어졌다 ([release-notes/2026](https://docs.devin.ai/release-notes/2026.md)).
  - "PR created", "Awaiting instructions", "Approve session" 같은 상태 라벨(5/8).
  - 폴더(6/12), nav 탭·grouping·filter 재설계(8/21), 태그별 개수(8/28).
  - PR 상태별·저장소별 묶기(9/2).
  - **Group by status: Working / Ready / Blocked / Inactive**(9/25). 입력이 필요한 세션은 Blocked 아래 따로 모인다.
  - hover 미리보기 카드(9/30).
  - **어떤 승인을 기다리는지 이름으로 표시**(9/30). 전에는 일반적인 "Approval required"였다.
  - PR 리뷰나 머지가 끝나면 그 요청 표시를 지운다(10/2).
  - 공식 사이드바 스크린샷은 찾지 못했다.

**상세**
- 한쪽에 채팅과 worklog, 다른 쪽에 workspace 탭(Progress, IDE, Browser, Shell, Diff, PR, Context, Terminal)이 있다 ([devin-session-tools](https://docs.devin.ai/work-with-devin/devin-session-tools.md)).
- 그 밖의 구성 요소
  - Tasks drawer(10/28).
  - 막힌 프롬프트 아래 "이유를 설명하는 blocked 카드"(10/26).
  - PR merge bar에 받은 승인 수와 필요한 승인 수(7/31).
  - 잠든 세션은 마지막 스크린샷과 "Wake up Devin" 버튼(9/9).
- **Interactive Planning**: 세션 초반에 관련 파일과 예비 플랜을 몇 초 만에 보여준다. 사용자가 고친 뒤 자율 실행으로 넘어간다.

**사람 개입**
- 사이드바의 Blocked 그룹과 승인별 라벨로 보인다.
- **알림 inbox**(10/7): 사이드바 종 아이콘에 세션 알림이 모인다. 알림 종류마다 따로 켜고 끈다(10/9).
- **Slack**: 세션과 Slack 스레드가 양방향으로 동기화된다. 승인과 네트워크 접근 요청을 Slack 버튼으로 처리한다(9/30). Slack, Teams, Linear의 승인 요청에는 "Devin이 무엇을 하려는지"가 적힌다(10/2) ([integrations/slack](https://docs.devin.ai/integrations/slack.md)).

**코디네이터 대 단일 에이전트**: **코디네이터가 있다(managed Devins)** ([advanced-capabilities](https://docs.devin.ai/work-with-devin/advanced-capabilities.md)).
- 코디네이터 세션이 자식 세션(각자 VM)을 만들고, 메시지를 보내고, 재우고, 종료한다. "모두 끝날 때까지 한 번의 호출로 기다릴" 수 있다.
- 자식이 끝나거나 입력이 필요하면 "**코디네이터가 자고 있어도 자동으로 깨운다**."
- "Auto-approve child sessions"를 끄면 자식을 띄우기 전에 사람이 배치를 검토한다.
- UI에서는 자식 세션이 **사이드바에 중첩 트리**로 보인다(8/21). 부모 헤더에는 세션 트리 아이콘(9/23), 필터에는 Sub-Devin(5/17)이 있다.
- 사용자가 자식에게 직접 메시지를 보낼 수 있는지는 문서에 없다 **(미검증)**.

**스크린샷**
- [Progress 탭](https://mintcdn.com/cognitionai/jXY34FCFVGnmuB3S/images/work-with-devin/devin-progress-tab.gif?s=b8f3d2f5fb24f229e04adf6487c92f1c)
- [Slack](https://mintcdn.com/cognitionai/4bS8zUS864bCAPVt/images/slack_chat.png?fit=max&auto=format&n=4bS8zUS864bCAPVt&q=85&s=45c726c4f5ddb93eef8d11641cdc7ff4)

### 1.7 Factory (Droids)

**개요**
- Factory App(데스크톱 + 웹/모바일 리뷰): "프로젝트와 머신을 가로질러 세션을 필터링하고 묶는다." Jira, Notion, Slack, Linear, PagerDuty와 동기화한다 ([factory-app/overview](https://docs.factory.com/factory-app/overview)). 일반 세션 목록의 상태 분류는 문서에 없다.
- **Workstreams**(beta, 날짜 미기재). BusyBoy와 가장 비슷하다 ([workstreams/overview](https://docs.factory.com/workstreams/overview)).
  - **왼쪽은 orchestrator 채팅, 오른쪽은 Agents 탭**이다.
  - Agents 탭은 에이전트를 **"Waiting on you" / "Working" / "Idle"**로 묶는다.
  - orchestrator는 "일을 계획하고, 에이전트를 띄우고, 조율을 유지하고, **결정이 사용자 몫이면 묻는다**."
  - 에이전트는 각자 맡은 조각을 끝내고 보고하며, PR을 연다.
  - "**어느 에이전트든 열어서 직접 대화할 수 있다.**"
  - Files 탭(공유 플랜·노트·결과물)과 PRs 탭(CI 상태)이 있다. 몇 시간에서 며칠 걸리는 작업에 권장된다.
- **Missions / Mission Control** ([missions/running-app](https://docs.factory.com/missions/running-app))
  - 왼쪽 사이드바: 실행 중이거나 끝난 worker 전체. 고르면 터미널 출력, 사고 과정, 하위 작업이 보인다.
  - 오른쪽: 모든 worker와 milestone의 progress log.
  - 위쪽: 시간과 크레딧.
  - 방향을 바꾸려면 orchestrator를 멈추고 재평가·재계획을 요청한 뒤 재개한다. Missions는 milestone을 먼저 계획하고, Workstreams는 대화에서 시작한다.

**상세**
- 문서, 슬라이드, 스프레드시트, PDF, 웹사이트, diff를 "세션 옆에" 렌더링한다. diff 줄에 inline 리뷰 코멘트를 단다. 적용하기 전에 무엇을 바꿀지 보여준다.

**사람 개입**
- **Autonomy 단계** ([auto-run](https://docs.factory.com/cli/user-guides/auto-run)). 위 단계가 아래 단계의 권한을 모두 포함한다.
  - Off: 읽기와 정책상 허용된 명령만.
  - Low: 파일 편집과 저위험 명령 추가.
  - Medium: 설치, commit, build 같은 되돌릴 수 있는 변경 추가.
  - High: migration, push 같은 고위험 작업 추가.
  - 현재 단계보다 위험한 동작은 inline으로 묻는다.
- **Spec Mode**: 읽기 전용으로 계획한다. 승인할 때 "Proceed with implementation"(수동 승인 유지)이나 Low/Medium/High 중에서 고른다.
- Workstreams에서는 사용자가 필요한 에이전트가 "Waiting on you"에 모인다.
- **Linear 연동** ([delegations/linear](https://docs.factory.com/delegations/linear))
  - issue를 Factory에 할당하거나 `@Factory`로 멘션하면, Linear agent session에 진행 상황을 올린다.
  - issue를 started로 옮기고 PR 링크를 붙인다.
  - "Open in Factory"로 전체 세션을 연다.

**코디네이터 대 단일 에이전트**: **둘 다 된다.** Workstreams와 Missions에 orchestrator가 있고, Workstreams에서는 에이전트와 직접 대화도 된다.

**스크린샷** (상대 경로로 조립한 URL)
- [Workstream overview](https://docs.factory.com/docs-assets/images/workstreams/workstream-overview.webp)
- [Mission web](https://docs.factory.com/docs-assets/images/mission-web.webp)
- [Linear mention](https://docs.factory.com/docs-assets/images/linear-mention.png)

### 1.8 Terragon (종료 후 오픈소스화)

- **상태**: README 기준 "2026-01-16 종료 시점의 오픈소스 스냅샷"이다. Apache-2.0이고, "클라우드에서 Claude Code, Codex 등을 돌리는 원격 백그라운드 에이전트 orchestrator"였다 ([terragon-oss](https://github.com/terragon-labs/terragon-oss)). 서비스 종료일(2026-02-09)은 **(미검증)**.

**개요**
- 왼쪽 사이드바의 태스크 목록이 Home과 태스크 화면 모두에 고정돼 있다. 저장소별이나 최근 갱신순으로 묶는다.
- 모두 "working"일 때 행이 덜 튀도록 정렬을 바꿨다(2025-11-17).
- **행 구성** ([managing-tasks.mdx](https://github.com/terragon-labs/terragon-oss/blob/main/apps/docs/content/docs/tasks/managing-tasks.mdx))
  - 왼쪽 상태 아이콘, 자동 생성 제목, 생성 시각, 저장소/브랜치.
  - 오른쪽 PR 상태 아이콘(Draft/Open/Merged/Closed, GitHub 색), CI 상태, 변경 줄 수.
  - 실행 중이면 에이전트 아이콘.
- **상태 값**: **Unread(파란 점)**, Pending, Running, Complete, Error. 코드에서는 세부 상태(queued, booting, working, checkpointing…)를 pending, active, finishing, complete, error 다섯 개로 합친다 ([thread-status.tsx](https://github.com/terragon-labs/terragon-oss/blob/main/apps/www/src/components/thread-status.tsx)).

**상세**
- 채팅에 inline 도구 렌더러(ExitPlanMode 플랜 카드 포함)가 있다. 보조 패널에는 diff 뷰어, 파일 트리, 터미널이 있다.
- 헤더에서 Retry, Fork, Share, Archive를 한다.
- 실행 중에 보낸 follow-up은 **큐에 쌓여 순서대로 실행된다**.
- 태스크 하나가 sandbox 하나, 브랜치 하나, 에이전트 하나다. PR은 자동으로 만든다.

**사람 개입**
- Plan mode에서는 "변경 전에 플랜을 승인하거나 고친다." 태스크 안에서 inline으로 한다.
- 완료되면 브라우저와 푸시 알림이 오고, 목록에 Unread 점이 붙는다.
- PR 리뷰는 GitHub에서 한다. PR 코멘트에 `@terragon-labs`를 달면 피드백으로 전달된다.

**코디네이터 대 단일 에이전트**: 코디네이터가 없다. Multi-Agent Mode는 프롬프트 하나를 여러 모델로 돌려 각각 별도 태스크로 만든다.

**스크린샷**: [dashboard](https://cdn.terragonlabs.com/dashboard-beRp.png), [multi-agent](https://cdn.terragonlabs.com/multi-agent-mode-5K1D.png), [diff viewer](https://cdn.terragonlabs.com/diff_viewer-gH9X.png). 종료 후 CDN이 죽었을 수 있다.

### 1.9 Vibe Kanban (BloopAI)

- **상태**: 회사(bloop)가 2026-04-10에 문을 닫았다. 지금은 커뮤니티가 유지하고, README 배너는 "Vibe Kanban is sunsetting"이다. 호스팅 칸반은 제거됐고 로컬 workspace는 동작한다 ([shutdown](https://www.vibekanban.com/blog/shutdown)).
- 저장소 정보: Apache-2.0, ★ 약 28.6k. 분석한 SHA는 `08064e0`(2026-11 main)과 비교용 `23049346`(2025-12)이다.

**개요 (칸반)**
- 로컬 태스크 enum: `Todo, InProgress, InReview, Done, Cancelled` (`08064e0:crates/db/src/models/task.rs:14-20`).
- 현재 보드 열은 설정할 수 있다. 기본값은 Backlog(숨김), To do, In progress, In review, Done, Cancelled(숨김)이다 (`crates/remote/src/db/project_statuses.rs:11-18`).
- **PR 신호로 열이 자동으로 바뀐다** (`crates/remote/src/db/issues.rs:520-594`). 드래그로 수동 이동도 된다.
  - PR이 열리면 In review.
  - 연결된 PR이 모두 머지되면 Done.
- **카드 구성** (`packages/ui/src/components/KanbanCardContent.tsx:204-325`)
  - ID와 실행 점, 제목, 설명 4줄, 우선순위와 담당자.
  - 태그, PR 배지(번호와 open/merged/closed), 관계 배지.
- **현재 보드 카드는 실시간 에이전트 상태를 보여주지 않는다.** `KanbanContainer.tsx:1043-1068`이 `isLoading`을 넘기지 않는다.
  - 2025-12 버전 카드는 실행 중이면 spinner, 마지막 시도가 실패하면 빨간 X를 보여줬다 (`23049346:frontend/src/components/tasks/TaskCard.tsx:113-117`).
  - 보드가 계획 화면으로 바뀌고, 실시간 상태는 다른 곳으로 옮겨갔다.

**상세**
- 카드를 누르면 오른쪽 issue 패널이 열린다. 설명, 하위 issue, 관계, 코멘트, **Workspaces** 목록이 있다. issue 하나에 workspace(옛 "attempt")가 여러 개 붙을 수 있다.
- **Workspace 카드** (`IssueWorkspaceCard.tsx:124-300`)
  - 상태 아이콘: 실행 점, **승인 대기 손 아이콘**, 실패 삼각형, 안 본 활동 점.
  - 변경 파일 수, +/- 줄 수, PR 버튼, "Xm ago".
- workspace를 열면 채팅, Changes(diff), diff 줄 코멘트(에이전트에게 전달), 터미널, 미리보기 브라우저, PR 생성과 머지가 있다.

**사람 개입**
- 채팅 안에 **inline 승인 카드**("Approve" / "Request Changes")가 뜬다. 승인에는 timeout이 있다 (`docs/workspaces/chat-interface.mdx`).
- AskUserQuestion은 입력창 위 배너로 뜬다 (`AskUserQuestionBanner.tsx`).
- **Workspaces 사이드바는 "Needs Attention" / "Idle" / "Running" 세 그룹**이다 (`WorkspacesSidebar.tsx:218-233`).
  - Needs Attention = `hasPendingApproval || (hasUnseenActivity && !isRunning)`.
- 완료, 주의 필요, 오류 때 소리와 브라우저 푸시가 온다.

**코디네이터 대 단일 에이전트**
- MCP 서버(`vibe-kanban --mcp`)에 `list_issues`, `create_issue`, `update_issue`, workspace 생성, `run_session_prompt` 같은 도구가 있어서 에이전트가 태스크를 만들고 다른 세션을 움직일 수 있다. `--mode orchestrator`도 있다 (`crates/mcp/src/bin/vibe_kanban_mcp.rs:39,89`).
- 코디네이터 전용 채팅 UI는 없다.

**스크린샷**
- [overview](https://raw.githubusercontent.com/BloopAI/vibe-kanban/main/packages/public/vibe-kanban-screenshot-overview.png)
- [workspace](https://raw.githubusercontent.com/BloopAI/vibe-kanban/main/packages/public/vibe-kanban-screenshot-workspace.png)
- [kanban board](https://raw.githubusercontent.com/BloopAI/vibe-kanban/main/docs/images/issue-mgmt-kanban-board.png)

### 1.10 Conductor (Melty Labs)

- **상태**: 2026-11-04 changelog 0.93.0에서 Meta 합류를 발표했다. Conductor Cloud는 11/13에 읽기 전용이 되고 11/20에 종료된다. Mac 앱은 2027년 초까지 지원한다 ([0.93.0](https://www.conductor.build/changelog/0.93.0-conductor-is-joining-meta)). 클로즈드 소스이고 문서가 얇아서 대부분 changelog로 확인했다.

**개요 (보드가 아닌 사이드바)**
- 0.35.0(2026-02-11): "workspace를 **backlog, in progress, in review, done**으로 정리"하고, PR이 있으면 PR 제목으로 표시한다 ([0.35.0](https://www.conductor.build/changelog/0.35.0-workspace-status)). 상태가 자동인지 수동인지는 **(미검증)**.
- 0.39.0: "플랜 승인과 사용자 입력 상태를 **구별되는 아이콘**으로", 실행 표시, 접힌 그룹 옆 개수, 머지된 PR은 보라색 ([0.39.0](https://www.conductor.build/changelog/0.39.0-insta-summarize-command-palette-opus-4-6)).
- 0.44.0 "New Sidebar" ([0.44.0](https://www.conductor.build/changelog/0.44.0-new-sidebar-rebuilt-composer-codex-checkpoints))
  - GitHub 상태(merged, CI 실패, 충돌)를 한눈에 보여준다.
  - **hover하면 메타데이터와 다음 행동이 뜬다. 지금 채팅을 떠나지 않아도 된다.**
  - 선택된 workspace를 다시 누르면 가장 오래된 안 읽은 채팅으로 간다.
  - 에이전트가 권한을 기다리면 사이드바에 표시된다.
- unread 표시(0.25.11), 보내지 않은 초안 아이콘(0.73.x), archive된 workspace를 모으는 History 패널이 있다.

**상세**
- workspace 하나가 브랜치(worktree) 하나다. 그 안에서 여러 에이전트 채팅을 돌린다(Claude Code, Codex, Cursor, OpenCode).
- 그 밖의 구성 요소
  - 터미널, Run 버튼.
  - Diff Viewer. 줄 코멘트는 composer 첨부로 에이전트에게 간다.
  - Checks 탭: git 상태, PR, CI, 배포, 리뷰 스레드, todo. 부드러운 머지 게이트 역할을 한다.
  - 앱 안의 PR 페이지(0.73.0).

**사람 개입**
- Plan mode에서 "승인하거나 피드백을 준다"(0.25.5).
- AskUserQuestion(0.31.3), 도구 승인(0.41.0, 엔터프라이즈 설정)이 있다.
- 주의가 필요한 상태는 사이드바 아이콘과 unread로 보인다. OS 알림 방식은 **(미검증)**.

**코디네이터 대 단일 에이전트**: 코디네이터가 없다. "Dispatcher"(0.63.0)는 빠른 생성 입력창일 뿐이다.

**스크린샷**
- [0.35.0 상태별 사이드바](https://conductor-marketing.t3.tigrisfiles.io/uploads/1770849671156-image.png)
- [0.44.0 새 사이드바](https://conductor-marketing.t3.tigrisfiles.io/uploads/1774395513472-image.png)

### 1.11 Sculptor (Imbue)

- **저장소 정보**: MIT, ★ 약 245, 최신 v0.49.0(2026-10-21). 분석한 SHA는 `bc1fd07`이다 ([imbue-ai/sculptor](https://github.com/imbue-ai/sculptor)).
- **변화**: 2025년 처음 공개됐을 때는 "에이전트마다 컨테이너"와, 컨테이너 작업을 로컬 저장소에 양방향 동기화하는 **Pairing Mode**가 핵심이었다 ([imbue.com/sculptor](https://imbue.com/sculptor/)). 지금은 git worktree가 기본이고, 컨테이너는 실험 기능이다. "pairing mode"는 문서에서 사라졌다.

**개요**
- workspace마다 상위 탭이 있고, 그 안에서 에이전트가 탭으로 나뉜다.
- **에이전트 상태 점**: running, waiting, error, unread, read (`bc1fd07:sculptor/frontend/src/common/utils/statusDot.ts:9-47`).
- **workspace 집계는 주의 우선이다**: WAITING > UNACKED_ERROR > UNREAD > RUNNING > IDLE.
  - "이미 본 오류는 일부러 IDLE로 내린다" (`statusDot.ts:106-130`).
  - 이 순위로 Cmd+K 순서도 정한다.
- workspace peek popover는 에이전트를 ERROR > WAITING > WORKING > COMPLETED > IDLE 순으로 정렬한다 (`WorkspacePeekPopover.tsx:44-63`).
- Home은 최근 workspace를 보여준다. Linear 확장을 켜면 "할당된 issue를 상태별로 묶은 보드형 home view"가 추가된다 (`docs/help/extensions.md`).

**상세**
- 채팅, Changes(실시간 diff, commit), 터미널, PR 버튼(open/merged/closed, 승인, 미해결 코멘트, CI)이 있다.
- **AgentTasksPanel**은 에이전트의 자체 태스크 목록을 의존 그래프로 보여준다. 예: "Waiting on #3, #5" (`AgentTasksPanel.tsx:15-34`).

**사람 개입**
- Claude의 AskUserQuestion과 ExitPlanMode를 **자체 도구로 바꿔 네이티브 패널로 띄운다.** 이유는 "알림이 사람에게 닿을 가능성이 더 높아서"다.
- 대기 중인 질문은 새로고침해도 남는다. 플랜 블록에는 "Approve plan" 버튼이 있다 (`docs/help/integrated_harnesses.md`).

**코디네이터 대 단일 에이전트**: 코디네이터가 없다. CI가 실패하면 "CI Babysitter" 에이전트 탭이 자동으로 생기지만, **바쁘거나 사용자를 기다리는 workspace는 건드리지 않는다** (`docs/help/ci_babysitter.md`).

### 1.12 Gas Town, agent-orchestrator (기존 리서치 재사용)

자세한 소스 분석은 [always-on-agents.md](./always-on-agents.md) §3.2–3.3에 있다. 여기서는 보드와 개입 관점만 정리한다.

- **agent-orchestrator** (`6430fe3b`)
  - 구조: 프로젝트당 orchestrator 세션 하나, 워커는 세션마다 worktree 하나. Electron 앱의 보드에 `needs_review` 열("다음 턴은 사람 차례")이 있다.
  - **표시 상태는 저장하지 않고 읽을 때 계산한다** (`docs/architecture.md:44-65`).
  - activity 값: `active | idle | waiting_input | blocked | exited`. `blocked`는 권한 다이얼로그에 걸린 상태이고, 에이전트 CLI hook에서 얻는다.
  - 알림은 orchestrator 에이전트가 아니라 **daemon**이 만든다.
  - 답은 워커 세션의 pending request로 **직접** 간다(`allow_once | allow_always | reject_once | reject_always`). **orchestrator는 워커의 승인을 대신 처리할 수 없다.**
- **Gas Town** (`466aa41c`)
  - 구조: tmux와 CLI 기반. Mayor가 코디네이터이고, `gt convoy list`가 모든 작업 목록이다.
  - 상태는 저장값을 믿지 않고 매번 tmux, git, beads를 관찰해 다시 만든다("Discover, Don't Track").
  - 사람 개입은 `gt escalate`(메일, 이메일, SMS)뿐이다. escalation 목록이 Mayor 세션을 시작할 때만 보이는 빈틈이 있다. **보드가 없는 시스템의 실패 사례**다.

### 1.13 그 밖의 OSS (짧게)

- **Nimbalyst** (구 Crystal; MIT, ★ 약 2.0k, `826adb4f`): **BusyBoy가 원하는 형태에 가장 가깝다.**
  - **세션 칸반의 열은 단계(phase)다**: Backlog / Planning / Implementing / Validating / Complete (`packages/electron/src/renderer/store/atoms/sessionKanban.ts:45-51`).
  - **실시간 상태는 열과 별개인 배지와 색조**로 보여준다: running(파랑), waiting(주황), unread 점, idle (`TrackerMode/SessionKanbanBoard.tsx:153-215`).
  - 부모 카드에는 자식 수("3 running", "2 waiting")와 상태 비율 막대가 붙는다.
  - Space로 transcript peek, Cmd+←/→로 열을 옮긴다.
  - 에이전트가 MCP `update_session_meta({phase})`로 **자기 열을 직접 정한다**. 첫 턴에 의무로 호출하게 한다 (`packages/runtime/src/ai/prompt.ts:25,61`).
  - [스크린샷](https://raw.githubusercontent.com/Nimbalyst/nimbalyst/main/.github/assets/sessions-kanban-dark.webp)
- **Jean** (coollabsio/jean; Apache-2.0, `29456a67`): 세션 카드 그리드를 **Waiting / In Progress / Review / Idle**로 묶는다.
  - Waiting의 세부 사유를 이름으로 보여준다: "Plan approval required", "Input required", "Permission required", "Command approval required", "Tool approval required" (`src/components/chat/session-card-utils.tsx:43-240`).
  - 사용자가 수동으로 상태를 정해도 **실시간 대기 상태가 항상 이긴다.**
- **Agent Deck** (asheshgoplani/agent-deck; MIT): TUI다.
  - 상태 기호: Running ●, Waiting ◐, Idle ○, Error ✕.
  - **"conductor" 감독 세션**이 다른 모든 세션을 지켜본다. "일상적인 질문은 대신 답하고, 흥미로운 질문은 휴대폰으로 올린다"(Telegram/Slack). BusyBoy PM과 가장 비슷한 OSS 개념이다.
- **Sidecar** (marcus/sidecar; MIT): 세션 화면을 **Needs Attention / Working / Live / Idle**로 묶고 미리보기 창을 둔다. [스크린샷](https://raw.githubusercontent.com/marcus/sidecar/main/docs/screenshots/sidecar-sessions.png)
- **Paradev** (구 Superset; MIT): worktree마다 태스크를 하나씩 두는 사이드바에 "working, done, waiting on you"를 표시한다. dock 배지와 inline 도구 승인이 있다.
- **Emdash**, **Claude Squad**, **opcode**: 세션 목록, diff, PR 중심이다. 칸반은 확인하지 못했다.

---

## 2. 비교표

| 제품 | 개요 형태 | 묶는 기준 / 상태 | 상세(클릭) | 질문·승인이 뜨는 곳 | 목록에서 바로 답하기 | 코디네이터 | 직접 대화 |
|---|---|---|---|---|---|---|---|
| Linear | issue 목록·보드 (Delegate 필터) | issue workflow 상태 + session 상태(`awaitingInput` 등) | issue 안의 Agent Session activity | issue 안 elicitation, 코멘트, 알림 | 아니요 | 없음 | 예 (issue에서) |
| GitHub Copilot / mission control | Agents panel, 전체 페이지 | 실시간 상태 (값 미검증) | 세션 로그 + steering 입력창, PR | PR 리뷰 요청, merge box "Approve and run workflows" | 아니요 | 없음 (목록 + 실행기) | 예 (steering) |
| Codex cloud / 앱 | 태스크 목록 (READY/PENDING/APPLIED/ERROR) | 상태 + 시도 수 | Conversation/Diff, attempt 전환 | 앱 Activity(종), OS 알림, 승인 오버레이에 출처 thread | Codex Micro 키 | main chat → subagent | 예 |
| Claude Code agent view | 터미널 목록 | Pinned / Ready for review / **Needs input** / Working / Completed | attach | 세션 안, 탭 제목 "N awaiting input" | **예 (Space peek, 번호로 답하기)** | 없음 | 예 |
| **Claude Code Projects** | 코디네이터 대화 + Overview 패널 | Ready for review / **Waiting on you** / Working / Landing / Idle / Resolved | Overview에 thread transcript | thread 안 (**코디네이터 경유 불가**) | 카드의 다음 행동 버튼 | **예** | **예** |
| Cursor | Agents Window 사이드바 + 타일 | pin, 저장소, workspace / unread | 채팅 + diff + PR | 채팅 안 inline, 상태줄, 묶은 OS 알림 | hover 카드 | 약함 (subagent) | 예 |
| Devin | 세션 사이드바 (자식은 트리) | Working / Ready / **Blocked** / Inactive, 승인 이름 표시 | worklog + IDE·Browser·Shell·Diff·PR | 사이드바 라벨, 종 inbox, Slack 버튼 | Slack 버튼 | **예 (managed Devins)** | 미검증 |
| **Factory Workstreams** | orchestrator 채팅 + Agents 탭 | **Waiting on you** / Working / Idle | 에이전트 열고 직접 대화, Files, PRs | Waiting on you 그룹, inline 승인 | 미검증 | **예** | **예** |
| Terragon | 사이드바 목록 | Unread / Pending / Running / Complete / Error + PR·CI 아이콘 | 채팅 + diff·터미널 | 태스크 안 플랜 카드, 푸시 알림 | 아니요 | 없음 | 예 (큐) |
| Vibe Kanban | **칸반** + Workspaces 사이드바 | 열: To do / In progress / In review / Done, 사이드바: **Needs Attention** / Idle / Running | 오른쪽 issue 패널 → workspace | 채팅 안 승인 카드, 손 아이콘 | 아니요 | MCP orchestrator 모드 (UI 없음) | 예 |
| Conductor | 상태별 사이드바 | backlog / in progress / in review / done + 승인·입력 아이콘 | workspace 채팅 + diff + Checks | 사이드바 아이콘, 채팅 안 | hover 다음 행동 | 없음 | 예 |
| Sculptor | workspace 탭 + 상태 점 | WAITING > ERROR > UNREAD > RUNNING > IDLE | 채팅 + Changes + PR | 네이티브 질문·플랜 패널 | peek popover | 없음 | 예 |
| Nimbalyst | **세션 칸반** | 열 = phase, **배지 = running/waiting/unread** | Space peek, transcript | 카드 배지, iOS 푸시 | peek | 없음 | 예 |
| agent-orchestrator | 보드 (`needs_review` 열) | 읽을 때 계산한 activity | 워커 세션 | daemon 알림 → 워커에게 직접 | 알림 버튼 | 예 (프로젝트당) | 예 |
| Gas Town | CLI `convoy list` | 관찰로 재계산 | tmux | 메일·SMS escalation | 아니요 | 예 (Mayor) | tmux |
| **BusyBoy (현재)** | PM 채팅 하나 + Lineage 패널 | task stage (보드 화면 없음) | Lineage에서 lead 스레드로 이동 | PM 타임라인의 결정 카드 | PM 타임라인 카드 | 예 (PM) | 예 (lead 스레드 열기) |

---

## 3. 공통 패턴

1. **수명주기와 실시간 상태를 나눈다.**
   - 수명주기는 열이나 그룹으로 보여준다(backlog → in progress → in review → done).
   - 실시간 상태(working, waiting on you, error, unread)는 카드의 배지와 색으로 보여준다.
   - 근거: Nimbalyst는 가장 명시적으로 나누고, Vibe Kanban 옛 카드와 Conductor 0.39 아이콘도 같은 방식이다.
   - 둘을 섞은 제품(Jean, Claude Projects)도 "Waiting on you"만은 따로 뺀다.
2. **"나를 기다리는 것"이 항상 맨 위다.** 기다리는 이유는 일반적인 "needs input"이 아니라 **구체적인 이름**으로 쓴다. 예: Devin 9/30, Jean "Plan approval required", Conductor 0.39 아이콘.
3. **답은 질문이 생긴 곳에서 한다.**
   - 목록은 모아서 보여주기만 하고, 빠른 답은 peek으로 한다(Claude agent view, Nimbalyst, Sculptor).
   - 코디네이터가 워커의 승인을 대신 처리하는 제품은 없다(Claude Projects, agent-orchestrator).
4. **코디네이터 채팅은 목록 옆에 둔다.** 목록을 코디네이터 채팅으로 대신하지 않는다.
   - Factory Workstreams: 왼쪽 채팅, 오른쪽 Agents.
   - Claude Projects: 대화와 Overview 패널.
   - Devin: 트리.
   - 셋 다 개별 에이전트를 열어 직접 대화할 수 있다.
5. **카드나 행에 들어가는 정보는 거의 같다.** 상태 아이콘, 제목, 최근 활동이나 지금 묻는 질문, 경과 시간, PR 배지(CI 색), diff 통계, unread 점이다. PR 이벤트가 상태를 자동으로 옮긴다(Vibe Kanban, Linear 권고).
6. **unread는 1급 상태다.** 보면 지워지고, 수동으로 다시 켤 수 있다(Terragon, Conductor, Cursor, Sculptor). 이미 본 오류는 순위를 내린다(Sculptor).

---

## 4. BusyBoy 권고: 따라 할 것과 피할 것

BusyBoy에 이미 있는 것:
- 태스크 stage: `inbox | planning | running | in_review | done | blocked | cancelled` (`packages/contracts/src/projectTeam.ts:45-53`).
- outcome: `waiting_user | in_review | done | failed | stalled`.
- 결정 카드: PM 타임라인에 병합되며, `projectTeam.answerDecision` → `AttentionRouter.answer`로 처리된다.
- Lineage 패널: `ThreadRelationshipsControl.tsx`. 실행 중인 lead가 위에 있고, 끝난 lead는 "Previous agents" 아래에 있다.
- PM 스레드와 sitrep.
- `team_status.otherThreads`.

### 패턴 1 (따라 하기): PM 화면을 "PM 채팅 + 태스크 보드" 2단으로

- **무엇**: PM 스레드를 왼쪽(좁게)에, 보드를 오른쪽(넓게)에 둔다. 출처는 Factory Workstreams와 Claude Projects Overview다.
- **매핑**
  - 보드 열은 `inbox → planning → running → in_review → done` stage를 그대로 쓴다.
  - `blocked`와 `cancelled`는 숨김 열이나 필터로 둔다(Vibe Kanban의 Backlog/Cancelled 숨김과 같은 방식).
  - `otherThreads`(PM이 만들지 않은 일반 스레드)는 보드 아래 "Other work" 줄로 둔다. 전체 프로젝트를 보는 원칙(always-on-agents.md P0-B)을 유지한다.
- **Lineage 패널**: PM 화면에서는 보드가 Lineage의 역할을 대신한다. 두 목록이 서로 어긋나지 않도록 Lineage는 일반 스레드의 subagent 보기에만 남긴다.
- **피할 것**: 보드를 PM 채팅을 대체하는 화면으로 만드는 것. 사용자가 PM과 대화하며 일을 만드는 흐름은 유지한다. Factory와 Claude Projects 모두 채팅을 남겼다.

### 패턴 2 (따라 하기): 열은 stage, 배지는 실시간 상태, "Needs you"는 맨 위

- **무엇**: 열과 실시간 상태를 분리한다(Nimbalyst). 사용자를 기다리는 카드는 열과 상관없이 보드 맨 위의 **"Needs you" 줄**에도 고정한다(Claude Projects "Waiting on you", Factory, Devin Blocked, Vibe Kanban Needs Attention).
- **매핑**
  - 카드 배지는 `lastOutcome`과 lead 스레드의 실행 상태에서 **읽는 시점에 계산한다**(agent-orchestrator). 값은 working / **needs you** / stalled / failed / unread다.
  - 배지 문구는 이유를 이름으로 쓴다. 예: "Plan approval", "Question", "PR review"(Devin 9/30, Jean). 결정 카드의 `kind`(approval/decision/blocker)를 그대로 쓰면 된다.
  - 카드 한 장의 구성(Claude agent view, Terragon)
    - `#번호`와 제목.
    - 한 줄짜리 **최근 활동 또는 지금 묻는 질문**.
    - 경과 시간.
    - PR 배지와 CI 색.
    - unread 점.
  - PR이 열리면 `in_review`로 자동 이동하는 것은 이미 lead가 `task_update(prUrl)`로 하고 있다. 머지되면 `done`으로 옮기는 것은 서버가 PR 상태를 보고 하는 방안을 검토한다(Vibe Kanban `issues.rs:520-594`).
- **피할 것**
  - **Vibe Kanban 최신 보드처럼 카드에서 실시간 상태를 빼는 것.** 보드가 계획 도구로 변해서 "진행 상황을 한눈에"라는 목표를 잃는다.
  - **stage를 에이전트의 산문으로만 바꾸는 것.** Nimbalyst는 에이전트가 자기 열을 직접 정한다. BusyBoy는 이미 `task_update`라는 구조화된 도구가 있으니 유지하되, 실시간 배지는 서버가 계산한다(Linear도 session 상태를 에이전트가 아니라 시스템이 정한다).

### 패턴 3 (따라 하기): 결정 카드는 태스크 카드와 peek에서 바로 답한다

- **무엇**: 질문은 질문이 생긴 태스크에 붙여서 보여준다. 보드를 떠나지 않고 peek으로 답할 수 있게 한다(Claude agent view의 Space peek과 번호 답, Nimbalyst, Sculptor peek).
- **매핑**
  - 지금의 `DecisionCard`(PM 타임라인 병합)를 **보드 카드의 펼침 영역과 peek 패널에서도** 렌더링한다. 같은 `ComposerPendingUserInputPanel`과 같은 초안 상태를 공유한다. PR #67의 inline과 Dialog 공유와 같은 방식이다.
  - 답은 지금처럼 `projectTeam.answerDecision` → `AttentionRouter.answer` → lead로 바로 가고, PM에게는 "[Decision answered]" 한 줄만 간다.
  - PM 타임라인의 결정 카드는 남겨 둔다. 다만 보드의 "Needs you" 줄이 1차 진입점이 된다.
- **피할 것**: **"PM에게 진행하라고 말하면 승인된다"는 경로.** Claude Projects는 문서에서 이를 명시적으로 막는다. BusyBoy 규칙("PM 메시지는 승인이 아니다")과도 맞는다. 승인은 카드 클릭이나 lead 스레드 안에서만 한다.

### 패턴 4 (따라 하기): 태스크를 열면 옆 패널, 거기서 보낸 말은 lead에게 바로

- **무엇**: 카드를 누르면 lead 스레드 transcript가 보드 옆(또는 split)에 열린다. 그 입력창의 메시지는 **PM을 거치지 않고** lead에게 바로 간다. 출처는 Claude Projects("거기서 보낸 메시지는 그 thread로 바로 간다"), Factory("어느 에이전트든 열어서 직접 대화"), Vibe Kanban 오른쪽 패널, Cursor 타일이다.
- **매핑**
  - 진행 중인 "Don't let the PM thread block" 태스크(steer instead of queue)와 직접 연결된다.
  - 실행 중인 lead에게 보낸 메시지의 기본 동작은 **steer**다(Codex iOS 2026-11-02, Copilot steering). Terragon처럼 큐에 쌓는 방식은 피한다.
  - 패널 헤더에는 stage, PR, 플랜 요약(`planSummary`)을 고정한다. Devin과 Linear의 Plan 체크리스트처럼 lead의 하위 작업 진행률을 보여주면 좋다. `ComposerTasksBadge`의 단계 정보를 재사용할 수 있다.
- **피할 것**: 카드를 누르면 화면 전체가 lead 스레드로 바뀌어 보드가 사라지는 것. 지금 Lineage에서 이동하는 방식이 그렇다. "아무것도 막지 않고"라는 요구에 어긋난다.

### 패턴 5 (따라 하기, 축소): sitrep은 보드의 변화 요약으로

- **무엇**: 보드가 상태를 늘 보여주므로 sitrep은 "**지난번 이후 바뀐 것**"과 "**결정이 필요한 것**"만 말한다.
- **매핑**
  - sitrep 메시지를 보드 위의 접히는 요약 띠나 PM 채팅의 짧은 글로 줄인다. 열린 결정 항목은 해당 카드로 가는 링크(`#N` 칩)로 단다.
  - 알림은 Cursor 3.26처럼 **멈춘 에이전트를 하나로 묶어** 보낸다. 내용에는 "무엇을 기다리는지"를 넣는다(Devin 10/2).
  - unread 점: 보드 카드에 lead 스레드의 안 읽은 활동을 표시한다(Terragon, Conductor, Sculptor). 이미 본 실패는 순위를 내린다(Sculptor).
- **피할 것**: 보드와 sitrep이 같은 정보를 두 번 길게 말하는 것. 그리고 Gas Town처럼 대기 목록을 특정 순간에만 보여주는 것.

### 따라 하지 않을 것

- **best-of-N(Codex attempts)과 issue당 여러 workspace(Vibe Kanban)**: BusyBoy는 태스크 하나에 lead 하나다. 시도 비교 UI는 지금 목표(진행 상황 보기와 막힘 없는 대화)와 관계가 없다.
- **코디네이터 없는 순수 목록(Conductor, Terragon, Cursor)**: BusyBoy의 PM은 가치가 있다. 목록만 따라 하면 PM의 종합·추천 역할이 사라진다.

---

## 5. 출처

**Linear**: https://linear.app/developers/agents · https://linear.app/developers/agent-interaction · https://linear.app/developers/agent-best-practices · https://linear.app/developers/agent-signals · https://linear.app/docs/agents-in-linear · https://linear.app/changelog/2025-07-30-agent-interaction-guidelines-and-sdk · https://linear.app/changelog/2025-08-21-cursor-agent · https://linear.app/changelog/2025-10-28-github-copilot-agent · https://linear.app/changelog/2025-12-04-openai-codex-agent · https://linear.app/changelog/2026-06-11-coding-sessions · https://linear.app/now/coding-sessions-for-linear-agent · https://linear.app/coding-sessions

**GitHub**: https://github.blog/news-insights/company-news/welcome-home-agents/ · https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/ · https://github.blog/changelog/2025-08-19-agents-panel-launch-copilot-coding-agent-tasks-anywhere-on-github-com/ · https://github.blog/changelog/2026-03-13-optionally-skip-approval-for-copilot-coding-agent-actions-workflows/ · https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents · https://docs.github.com/en/copilot/how-tos/github-copilot-app/agent-sessions · https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github · https://docs.github.com/copilot/how-tos/agents/copilot-coding-agent/reviewing-a-pull-request-created-by-copilot

**OpenAI Codex**: https://learn.chatgpt.com/docs/cloud · https://learn.chatgpt.com/docs/developer-commands · https://learn.chatgpt.com/docs/notifications.md · https://learn.chatgpt.com/docs/features/codex-micro.md · https://learn.chatgpt.com/docs/environments/git-worktrees.md · https://learn.chatgpt.com/docs/llms-full.txt · https://learn.chatgpt.com/docs/changelog · https://github.com/openai/codex/tree/main/codex-rs/cloud-tasks

**Claude Code**: https://www.anthropic.com/news/claude-code-on-the-web · https://code.claude.com/docs/en/claude-code-on-the-web · https://code.claude.com/docs/en/web-quickstart · https://code.claude.com/docs/en/desktop · https://code.claude.com/docs/en/agent-view · https://code.claude.com/docs/en/agents · https://code.claude.com/docs/en/claude-projects

**Cursor**: https://cursor.com/docs/cloud-agent · https://cursor.com/changelog/2-0 · https://cursor.com/changelog/3-0 · https://cursor.com/changelog/3-1 · https://cursor.com/blog/cursor-3 · https://cursor.com/docs/agent/agents-window · https://cursor.com/docs/release-notes · https://cursor.com/docs/integrations/linear

**Devin**: https://cognition.com/blog/devin-2 · https://docs.devin.ai/work-with-devin/advanced-capabilities.md · https://docs.devin.ai/work-with-devin/devin-session-tools.md · https://docs.devin.ai/release-notes/2026.md · https://docs.devin.ai/integrations/slack.md

**Factory**: https://docs.factory.com/factory-app/overview · https://docs.factory.com/factory-app/quickstart · https://docs.factory.com/workstreams/overview · https://docs.factory.com/missions/running-app · https://docs.factory.com/cli/user-guides/auto-run · https://docs.factory.com/delegations/linear

**Terragon**: https://github.com/terragon-labs/terragon-oss (apps/docs/content/docs/tasks/*.mdx, apps/www/src/components/thread-status.tsx)

**Vibe Kanban**: https://github.com/BloopAI/vibe-kanban (commit `08064e043c2d78ad123b473257ed867e7ce74768`, 비교용 `23049346f5596cfa9f8c1a98759b7b06ea23ab97`) · https://www.vibekanban.com/blog/shutdown · https://vibekanban.com/docs

**Conductor**: https://www.conductor.build/docs/ · https://www.conductor.build/changelog (0.25.11, 0.35.0, 0.39.0, 0.41.0, 0.44.0, 0.63.0, 0.73.0, 0.93.0)

**Sculptor**: https://imbue.com/sculptor/ · https://github.com/imbue-ai/sculptor (commit `bc1fd075a10e3780a30c481e53f9fae4677245ad`)

**기타 OSS**: https://github.com/Nimbalyst/nimbalyst (`826adb4f93dbe86db35b76ce2502a3a33abe0489`) · https://github.com/coollabsio/jean (`29456a678977fca27ed0f0c055c2caae596fd691`) · https://github.com/asheshgoplani/agent-deck · https://github.com/marcus/sidecar · https://github.com/superset-sh/superset · https://github.com/generalaction/emdash · https://github.com/smtg-ai/claude-squad · https://github.com/winfunc/opcode

**기존 리서치**: docs/research/always-on-agents.md (agent-orchestrator `6430fe3b`, Gas Town `466aa41c`)

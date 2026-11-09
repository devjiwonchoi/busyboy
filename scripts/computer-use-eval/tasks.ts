// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A plain Node evaluation harness.
import { randomInt } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Mac } from "./mac.ts";

export interface TaskContext {
  mac: Mac;
  workDir: string;
  vars: Record<string, string>;
}
export interface EvalTask {
  id: string;
  app: "Notes" | "Safari" | "Google Chrome" | "Slack" | "Calendar" | "System Settings" | "TextEdit";
  prompt: string;
  setup(ctx: TaskContext): Promise<Record<string, string>>;
  judge(ctx: TaskContext, answer: string): Promise<{ pass: boolean; detail: string }>;
  cleanup(ctx: TaskContext): Promise<string | void>;
}

/** Shared by every prompt; the classifier strips it from transcripts. */
export const TOOL_RULE =
  "computer_* 도구만 사용하고 shell/osascript/AppleScript 또는 다른 도구로 수행하지 마세요.";
const instruction = `\n${TOOL_RULE} 마지막 답변은 "답: <값>" 줄로 끝내세요. 작업 수행 요청이면 "답: 완료"로 끝내세요.`;
const prompt = (text: string) => text + instruction;
export const asString = (text: string) =>
  '"' +
  text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n") +
  '"';
const code = () =>
  Array.from({ length: 6 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[randomInt(36)]).join("");
const result = (pass: boolean, detail: string) => ({ pass, detail });
const noop = async () => {};
const emptySetup = async () => ({});

// Resolve attempt-specific titles without changing prompts that need no tag.
export function promptFor(task: EvalTask, vars: Record<string, string>): string {
  return task.prompt.replaceAll("{tag}", vars.tag ?? "{tag}");
}

export function answerLine(answer: string): string {
  return [...answer.matchAll(/^\s*답\s*[:：]\s*(.+)$/gm)].at(-1)?.[1]?.trim() ?? answer;
}

// Reject ambiguous mode answers, even when they include the expected token.
const modeTokens = {
  system: /시스템|system/i,
  auto: /자동|\bauto\b/i,
  dark: /다크|\bdark\b/i,
  light: /라이트|\blight\b/i,
};
function modeResult(answer: string, expected: keyof typeof modeTokens) {
  const line = answerLine(answer);
  return result(
    Object.entries(modeTokens).every(
      ([mode, pattern]) => pattern.test(line) === (mode === expected),
    ),
    `Expected ${expected}; answer: ${line}`,
  );
}

// The second pass empties Recently Deleted, so an old note cannot pass a later attempt.
async function deleteNotes({ mac }: TaskContext) {
  for (let pass = 0; pass < 2; pass++) {
    await mac.osascript(
      'tell application "Notes" to delete (every note whose name starts with "BBEval")',
    );
  }
}
async function noteText({ mac }: TaskContext, title: string) {
  return mac.osascript(`tell application "Notes"
set found to every note whose name starts with ${asString(title)}
set output to ""
repeat with n in found
set output to output & (plaintext of n) & (ASCII character 30)
end repeat
return output
end tell`);
}
async function createNote(ctx: TaskContext, title: string, body: string) {
  await ctx.mac.osascript(
    `tell application "Notes" to tell default account to make new note with properties {body:${asString(`<h1>${title}</h1><div>${body}</div>`)}}`,
  );
}
function notesTask(
  id: string,
  title: string,
  text: string,
  body: string,
  judge: EvalTask["judge"],
): EvalTask {
  return {
    id,
    app: "Notes",
    prompt: prompt(text),
    setup: async (ctx) => {
      const vars = { code: code() };
      if (body) {
        await createNote(ctx, title, body.replace("<CODE>", vars.code));
      }
      return vars;
    },
    judge,
    cleanup: deleteNotes,
  };
}

async function writePages(
  ctx: TaskContext,
  pages: Record<string, string>,
  app: string,
  first: string,
) {
  await ctx.mac.mkdirp(join(ctx.workDir, "pages"));
  for (const [name, html] of Object.entries(pages)) {
    await ctx.mac.writeFile(
      join(ctx.workDir, "pages", name),
      `<!doctype html><html lang="ko"><meta charset="utf-8">${html}</html>`,
    );
  }
  await ctx.mac.run("open", ["-a", app, pathToFileURL(join(ctx.workDir, "pages", first)).href]);
}
function pageCleanup(app: "Safari" | "Google Chrome", files: string[]): EvalTask["cleanup"] {
  return async (ctx) => {
    // Only evaluation tabs may be closed; absent windows are harmless.
    const closeTabs = ctx.mac.osascript(`tell application ${asString(app)}
repeat with wi from (count windows) to 1 by -1
set w to window wi
repeat with i from (count tabs of w) to 1 by -1
try
set t to tab i of w
if ${app === "Safari" ? "name" : "title"} of t starts with "BBEval" then
close t
end if
end try
end repeat
end repeat
end tell`);
    // Safari cleanup is best-effort; tagged titles distinguish any stale tabs.
    let warning: string | undefined;
    try {
      await closeTabs;
    } catch (error) {
      if (app !== "Safari") {
        throw error;
      }
      warning = `Safari tabs not closed: ${String(error)}`;
    }
    for (const name of files) {
      await ctx.mac.removeFile(join(ctx.workDir, "pages", name));
    }
    return warning;
  };
}
const tabURLs = (mac: Mac, app: string) =>
  mac.osascript(`tell application ${asString(app)}
set output to ""
repeat with w in windows
repeat with t in tabs of w
set output to output & (URL of t) & linefeed
end repeat
end repeat
return output
end tell`);

async function slackState(ctx: TaskContext) {
  const paths = [
    "Library/Containers/com.tinyspeck.slackmacgap/Data/Library/Application Support/Slack/storage/root-state.json",
    "Library/Application Support/Slack/storage/root-state.json",
  ];
  for (const path of paths) {
    const fullPath = join(ctx.mac.homeDir(), path);
    if (await ctx.mac.exists(fullPath)) {
      return JSON.parse(await ctx.mac.readFile(fullPath)) as {
        workspaces: Record<string, { domain: string }>;
        settings: { systemThemeSyncEnabled: boolean; userTheme: string };
      };
    }
  }
  throw new Error("Slack root-state.json not found; sign in to Slack before running this task.");
}
const slackSetup: EvalTask["setup"] = async (ctx) => {
  await slackState(ctx);
  return {};
};

// Build local dates in Calendar, without locale-dependent date strings.
const calendarDates = `set d1 to current date
set time of d1 to 0
set tomorrow to d1 + days`;
async function deleteEvents({ mac }: TaskContext) {
  await mac.osascript(`tell application "Calendar"
set d1 to current date
set time of d1 to 0
set d2 to d1 + 400 * days
set d1 to d1 - 30 * days
repeat with c in (every calendar whose writable is true)
set matches to every event of c whose summary starts with "BBEval" and start date ≥ d1 and start date < d2
if (count matches) > 0 then
delete matches
end if
end repeat
end tell`);
}
async function calendarJudge(ctx: TaskContext, title: string, hour: number, exactlyOne: boolean) {
  const output = await ctx.mac.osascript(`tell application "Calendar"
${calendarDates}
set output to ""
repeat with c in calendars
repeat with e in (every event of c whose summary is ${asString(title)} and start date ≥ tomorrow and start date < (tomorrow + days))
set s to start date of e
set f to end date of e
set output to output & (summary of e) & "|" & (my stamp(s)) & "|" & (my stamp(f)) & linefeed
end repeat
end repeat
return output
end tell
on stamp(d)
return ((year of d) as text) & "-" & ((month of d) as integer) & "-" & (day of d) & "T" & (hours of d) & ":" & (minutes of d) & ":" & (seconds of d)
end stamp`);
  const tomorrow = ctx.mac.now();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = `${tomorrow.getFullYear()}-${tomorrow.getMonth() + 1}-${tomorrow.getDate()}`;
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  const expected = `${title}|${day}T${hour}:0:0|${day}T${hour + 1}:0:0`;
  return result(
    lines.includes(expected) && (!exactlyOne || lines.length === 1),
    `Expected ${expected}; found ${output}`,
  );
}

// Missing defaults keys mean the system uses its documented default.
async function readDefault(mac: Mac, key: string) {
  try {
    return await mac.run("defaults", ["read", "-g", key]);
  } catch (error) {
    if (/does not exist/i.test(String(error))) {
      return "";
    }
    throw error;
  }
}
async function closeTextEdit(ctx: TaskContext) {
  await ctx.mac
    .osascript(
      'tell application "TextEdit" to close (every document whose name is "BBEval 메모.txt") saving no',
    )
    .catch((error: unknown) => {
      // -600: TextEdit is not running, so there is nothing to close.
      if (!String(error).includes("(-600)")) {
        throw error;
      }
    });
}

export const TASKS: ReadonlyArray<EvalTask> = [
  notesTask(
    "notes-create",
    "BBEval 장보기",
    'Notes 앱에서 제목이 "BBEval 장보기"인 새 메모를 만들고 본문에 "우유, 계란, 사과"를 적어줘.',
    "",
    async (ctx) => {
      const text = await noteText(ctx, "BBEval 장보기");
      return result(
        text
          .split("\x1e")
          .some((note) => ["우유", "계란", "사과"].every((word) => note.includes(word))),
        `Note plaintext: ${text}`,
      );
    },
  ),
  notesTask(
    "notes-append",
    "BBEval 회의록",
    'Notes의 "BBEval 회의록" 메모 맨 끝에 "2. 예산 검토" 줄을 추가해줘.',
    "1. 일정 확인",
    async (ctx) => {
      const text = await noteText(ctx, "BBEval 회의록");
      return result(
        text.split("\x1e").some((note) => {
          const lines = note.split(/\r?\n/);
          const original = lines.findIndex((line) => line.includes("1. 일정 확인"));
          return (
            original >= 0 && lines.findIndex((line) => line.includes("2. 예산 검토")) > original
          );
        }),
        `Note plaintext: ${text}`,
      );
    },
  ),
  notesTask(
    "notes-read",
    "BBEval 와이파이",
    'Notes의 "BBEval 와이파이" 메모에 적힌 비밀번호를 알려줘.',
    "비밀번호: <CODE>",
    async (ctx, answer) =>
      result(
        Boolean(ctx.vars.code) && answer.includes(ctx.vars.code!),
        "Password must match the setup code.",
      ),
  ),
  {
    id: "safari-read",
    app: "Safari",
    prompt: prompt('Safari에 열린 "BBEval 확인 코드 {tag}" 페이지에 적힌 확인 코드를 알려줘.'),
    setup: async (ctx) => {
      const vars = { code: code(), tag: code().slice(0, 4) };
      await writePages(
        ctx,
        {
          "read.html": `<title>BBEval 확인 코드 ${vars.tag}</title><body>확인 코드: ${vars.code}</body>`,
        },
        "Safari",
        "read.html",
      );
      return vars;
    },
    judge: async (ctx, answer) =>
      result(
        Boolean(ctx.vars.code) && answer.includes(ctx.vars.code!),
        "Confirmation code must match.",
      ),
    cleanup: pageCleanup("Safari", ["read.html"]),
  },
  {
    id: "safari-navigate",
    app: "Safari",
    prompt: prompt(
      'Safari의 "BBEval 목차 {tag}" 페이지에서 "3장" 링크를 눌러 이동한 뒤, 3장 페이지에 적힌 확인 코드를 알려줘.',
    ),
    setup: async (ctx) => {
      // The code exists only on chapter 3, so reading it proves the navigation.
      const vars = { code: code(), tag: code().slice(0, 4) };
      const pages: Record<string, string> = {
        "toc.html":
          `<title>BBEval 목차 ${vars.tag}</title><body>` +
          [1, 2, 3].map((n) => `<a href="chapter${n}.html">${n}장</a>`).join(" ") +
          "</body>",
      };
      for (const n of [1, 2, 3]) {
        pages[`chapter${n}.html`] =
          `<title>BBEval ${n}장 ${vars.tag}</title><body>${n}장${n === 3 ? ` 확인 코드: ${vars.code}` : ""}</body>`;
      }
      await writePages(ctx, pages, "Safari", "toc.html");
      return vars;
    },
    judge: async (ctx, answer) =>
      result(
        Boolean(ctx.vars.code) && answer.includes(ctx.vars.code!),
        "Chapter 3 code must match.",
      ),
    cleanup: pageCleanup("Safari", ["toc.html", "chapter1.html", "chapter2.html", "chapter3.html"]),
  },
  {
    id: "chrome-form",
    app: "Google Chrome",
    prompt: prompt(
      'Chrome에 열린 "BBEval 신청서" 폼에서 이름에 "홍길동", 옵션에 "옵션 B"를 고르고 제출해줘.',
    ),
    setup: async (ctx) => {
      await writePages(
        ctx,
        {
          "form.html":
            '<title>BBEval 신청서</title><body><form method="get" action="done.html"><label>이름 <input name="name"></label><label>옵션 <select name="choice"><option value="a">옵션 A</option><option value="b">옵션 B</option><option value="c">옵션 C</option></select></label><button type="submit">제출</button></form></body>',
          "done.html": "<title>BBEval 완료</title><body>완료</body>",
        },
        "Google Chrome",
        "form.html",
      );
      return {};
    },
    judge: async (ctx) => {
      const urls = await tabURLs(ctx.mac, "Google Chrome");
      const pass = urls.split(/\r?\n/).some((line) => {
        if (!URL.canParse(line)) {
          return false;
        }
        const url = new URL(line);
        return (
          url.href.split(/[?#]/)[0] === pathToFileURL(join(ctx.workDir, "pages/done.html")).href &&
          url.searchParams.get("name") === "홍길동" &&
          url.searchParams.get("choice") === "b"
        );
      });
      // Only evaluation pages go into the result; other tabs are the user's own.
      const pagesUrl = pathToFileURL(join(ctx.workDir, "pages")).href;
      const ours = urls.split(/\r?\n/).filter((line) => line.startsWith(pagesUrl));
      return result(pass, `Evaluation tab URLs: ${ours.join(" ") || "none"}`);
    },
    cleanup: pageCleanup("Google Chrome", ["form.html", "done.html"]),
  },
  {
    id: "slack-workspace",
    app: "Slack",
    prompt: prompt(
      "Slack 앱에서 지금 로그인된 워크스페이스의 주소(도메인, 예: xxx.slack.com)를 알려줘.",
    ),
    setup: slackSetup,
    judge: async (ctx, answer) => {
      const state = await slackState(ctx);
      const tokens = answerLine(answer)
        .toLowerCase()
        .split(/[^a-z0-9.-]+/);
      return result(
        Object.values(state.workspaces).some(
          ({ domain }) =>
            Boolean(domain) &&
            (tokens.includes(domain.toLowerCase()) ||
              tokens.includes(`${domain.toLowerCase()}.slack.com`)),
        ),
        "Answer must contain a signed-in Slack workspace domain.",
      );
    },
    cleanup: noop,
  },
  {
    id: "slack-theme",
    app: "Slack",
    prompt: prompt(
      'Slack 환경설정(Preferences)의 테마 설정에서 지금 라이트/다크 중 무엇이 선택돼 있는지 알려줘. 시스템 설정과 동기화 중이면 "시스템"이라고 답해.',
    ),
    setup: slackSetup,
    judge: async (ctx, answer) => {
      const { settings } = await slackState(ctx);
      if (settings.systemThemeSyncEnabled) {
        return modeResult(answer, "system");
      }
      if (settings.userTheme !== "dark" && settings.userTheme !== "light") {
        throw new Error("Unknown Slack userTheme.");
      }
      return modeResult(answer, settings.userTheme);
    },
    cleanup: noop,
  },
  {
    id: "calendar-create",
    app: "Calendar",
    prompt: prompt('Calendar 앱에서 내일 오후 3시부터 4시까지 "BBEval 치과" 일정을 만들어줘.'),
    setup: emptySetup,
    judge: (ctx) => calendarJudge(ctx, "BBEval 치과", 15, false),
    cleanup: deleteEvents,
  },
  {
    id: "calendar-move",
    app: "Calendar",
    prompt: prompt(
      'Calendar의 내일 "BBEval 회의" 일정을 같은 날 오전 11시로 옮겨줘(1시간 길이는 유지).',
    ),
    setup: async (ctx) => {
      const calendar = await ctx.mac.osascript(`tell application "Calendar"
${calendarDates}
set c to first calendar whose writable is true
set s to tomorrow + 10 * hours
set f to tomorrow + 11 * hours
make new event at end of events of c with properties {summary:"BBEval 회의", start date:s, end date:f}
return name of c
end tell`);
      return { calendar };
    },
    judge: (ctx) => calendarJudge(ctx, "BBEval 회의", 11, true),
    cleanup: deleteEvents,
  },
  {
    id: "settings-macos-version",
    app: "System Settings",
    prompt: prompt("시스템 설정 앱에서 이 Mac의 macOS 버전 번호를 확인해 알려줘."),
    setup: emptySetup,
    judge: async (ctx, answer) => {
      const version = (await ctx.mac.run("sw_vers", ["-productVersion"])).trim();
      const acceptable = /^\d+\.\d+\.0$/.test(version) ? version.slice(0, -2) : version;
      const versions: string[] = answer.match(/\d+(?:\.\d+)+/g) ?? [];
      return result(
        versions.includes(version) || versions.includes(acceptable),
        `Expected macOS ${version}`,
      );
    },
    cleanup: noop,
  },
  {
    id: "settings-appearance",
    app: "System Settings",
    prompt: prompt(
      "시스템 설정 앱의 화면 모드(모양) 설정에서 지금 라이트/다크/자동 중 무엇이 선택돼 있는지 알려줘.",
    ),
    setup: emptySetup,
    judge: async (ctx, answer) => {
      if ((await readDefault(ctx.mac, "AppleInterfaceStyleSwitchesAutomatically")) === "1") {
        return modeResult(answer, "auto");
      }
      return modeResult(
        answer,
        (await readDefault(ctx.mac, "AppleInterfaceStyle")).toLowerCase() === "dark"
          ? "dark"
          : "light",
      );
    },
    cleanup: noop,
  },
  {
    id: "textedit-append",
    app: "TextEdit",
    prompt: prompt(
      'TextEdit에 열린 "BBEval 메모.txt" 문서 끝에 "테스트 완료" 줄을 추가하고 저장해줘.',
    ),
    setup: async (ctx) => {
      await ctx.mac.mkdirp(join(ctx.workDir, "files"));
      const path = join(ctx.workDir, "files/BBEval 메모.txt");
      await ctx.mac.writeFile(path, "안녕하세요\n");
      await ctx.mac.run("open", ["-a", "TextEdit", path]);
      return {};
    },
    judge: async (ctx) => {
      const lines = (await ctx.mac.readFile(join(ctx.workDir, "files/BBEval 메모.txt")))
        .split(/\r?\n/)
        .map((line) => line.trim());
      return result(
        lines.includes("안녕하세요") && lines.indexOf("테스트 완료") > lines.indexOf("안녕하세요"),
        "Saved file must contain the original line followed by 테스트 완료.",
      );
    },
    cleanup: async (ctx) => {
      await closeTextEdit(ctx);
      await ctx.mac.removeFile(join(ctx.workDir, "files/BBEval 메모.txt"));
    },
  },
];

export function findTask(id: string): EvalTask {
  const task = TASKS.find((task) => task.id === id);
  if (!task) {
    throw new Error(`Unknown task: ${id}`);
  }
  return task;
}

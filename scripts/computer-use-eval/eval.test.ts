// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - A plain Node evaluation harness.
import { describe, expect, it, vi } from "vite-plus/test";
import { main, parseArgs } from "./cli.ts";
import type { Mac } from "./mac.ts";
import {
  answerLine,
  asString,
  findTask,
  promptFor,
  TASKS,
  TOOL_RULE,
  type TaskContext,
} from "./tasks.ts";
import {
  classifyFailure,
  FAILURE_RULE_ORDER,
  renderReport,
  summarize,
  type AttemptResult,
} from "./report.ts";

class FakeMac implements Mac {
  files = new Map<string, string>();
  scripts: string[] = [];
  calls: { cmd: string; args: string[] }[] = [];
  scriptOutput = "";
  scriptError: Error | null = null;
  runOutputs = new Map<string, string | Error>();
  osascript = async (script: string) => {
    this.scripts.push(script);
    if (this.scriptError) {
      throw this.scriptError;
    }
    return this.scriptOutput;
  };
  readFile = async (path: string) => {
    const text = this.files.get(path);
    if (text === undefined) {
      throw new Error(`Missing file: ${path}`);
    }
    return text;
  };
  writeFile = async (path: string, text: string) => {
    this.files.set(path, text);
  };
  removeFile = async (path: string) => {
    this.files.delete(path);
  };
  mkdirp = async () => {};
  exists = async (path: string) => this.files.has(path);
  run = async (cmd: string, args: string[]) => {
    this.calls.push({ cmd, args });
    const value = this.runOutputs.get([cmd, ...args].join(" ")) ?? "";
    if (value instanceof Error) {
      throw value;
    }
    return value;
  };
  homeDir = () => "/home/test";
  now = () => new Date(2026, 10, 8, 12);
}
const context = (mac: FakeMac): TaskContext => ({
  mac,
  workDir: "/eval/work",
  vars: { code: "A1B2C3" },
});
const slackPath = "/home/test/Library/Application Support/Slack/storage/root-state.json";

it("loads 13 unique tasks with constrained Korean prompts", () => {
  expect(TASKS).toHaveLength(13);
  expect(new Set(TASKS.map((task) => task.id)).size).toBe(13);
  for (const task of TASKS) {
    expect(task.prompt).toContain("computer_*");
    expect(task.prompt).toContain("답:");
    expect(findTask(task.id)).toBe(task);
  }
  expect(() => findTask("missing")).toThrow("Unknown task");
});

it("parses the last answer line and escapes AppleScript strings", () => {
  expect(answerLine("답: 라이트\n설명\n 답 ： 다크\n")).toBe("다크");
  expect(answerLine("plain")).toBe("plain");
  expect(asString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
});

describe("task judges", () => {
  it("checks note content and append order", async () => {
    const mac = new FakeMac();
    mac.scriptOutput = "BBEval 장보기\n우유, 계란, 사과";
    expect((await findTask("notes-create").judge(context(mac), "")).pass).toBe(true);
    mac.scriptOutput = "우유, 사과";
    expect((await findTask("notes-create").judge(context(mac), "")).pass).toBe(false);
    mac.scriptOutput = "1. 일정 확인\n2. 예산 검토";
    expect((await findTask("notes-append").judge(context(mac), "")).pass).toBe(true);
    mac.scriptOutput = "1. 일정 확인 2. 예산 검토";
    expect((await findTask("notes-append").judge(context(mac), "")).pass).toBe(false);
    mac.scriptOutput = "2. 예산 검토\n1. 일정 확인";
    expect((await findTask("notes-append").judge(context(mac), "")).pass).toBe(false);
  });
  it("checks generated codes in the full answer", async () => {
    const ctx = context(new FakeMac());
    for (const id of ["notes-read", "safari-read"]) {
      expect((await findTask(id).judge(ctx, "코드는 A1B2C3\n답: 완료")).pass).toBe(true);
      expect((await findTask(id).judge(ctx, "답: WRONG")).pass).toBe(false);
    }
  });
  it("persists setup code and creates a labeled local form", async () => {
    const mac = new FakeMac();
    const vars = await findTask("safari-read").setup(context(mac));
    expect(vars.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(await mac.readFile("/eval/work/pages/read.html")).toContain(vars.code!);
    await findTask("chrome-form").setup(context(mac));
    expect(await mac.readFile("/eval/work/pages/form.html")).toContain(
      '<label>이름 <input name="name">',
    );
    expect(mac.calls.at(-1)?.args).toEqual([
      "-a",
      "Google Chrome",
      "file:///eval/work/pages/form.html",
    ]);
  });
  it.each(["safari-read", "chrome-form"])("cleans %s tabs and windows in reverse", async (id) => {
    const mac = new FakeMac();
    await findTask(id).cleanup(context(mac));
    expect(mac.scripts[0]).toContain(
      "repeat with wi from (count windows) to 1 by -1\nset w to window wi",
    );
    expect(mac.scripts[0]).toContain("repeat with i from (count tabs of w) to 1 by -1\ntry");
    expect(mac.scripts[0]).toContain('starts with "BBEval" then\nclose t\nend if\nend try');
  });
  it("cleans wrong-date BBEval events only from writable calendars", async () => {
    const mac = new FakeMac();
    await findTask("calendar-create").cleanup(context(mac));
    expect(mac.scripts[0]).toContain("set d2 to d1 + 400 * days");
    expect(mac.scripts[0]).toContain("set d1 to d1 - 30 * days");
    expect(mac.scripts[0]).toContain("every calendar whose writable is true");
    expect(mac.scripts[0]).toContain(
      'summary starts with "BBEval" and start date ≥ d1 and start date < d2',
    );
  });
  it("judges safari-navigate by the code that only chapter 3 shows", async () => {
    const mac = new FakeMac();
    const ctx = context(mac);
    ctx.vars = await findTask("safari-navigate").setup(ctx);
    const pages = [...mac.files.entries()];
    const chapter3 = pages.find(([path]) => path.endsWith("chapter3.html"))?.[1] ?? "";
    expect(chapter3).toContain(ctx.vars.code);
    expect(
      pages
        .filter(([path]) => !path.endsWith("chapter3.html"))
        .map(([, html]) => html)
        .join(""),
    ).not.toContain(ctx.vars.code);
    expect((await findTask("safari-navigate").judge(ctx, `답: ${ctx.vars.code}`)).pass).toBe(true);
    expect((await findTask("safari-navigate").judge(ctx, "답: 완료")).pass).toBe(false);
  });
  it("still removes Safari pages and reports refused Apple Events", async () => {
    const mac = new FakeMac();
    await findTask("safari-read").setup(context(mac));
    mac.scriptError = new Error("Apple Events refused (-1743)");
    await expect(findTask("safari-read").cleanup(context(mac))).resolves.toBe(
      "Safari tabs not closed: Error: Apple Events refused (-1743)",
    );
    expect(mac.files.has("/eval/work/pages/read.html")).toBe(false);
  });
  it("propagates Chrome cleanup errors", async () => {
    const mac = new FakeMac();
    mac.scriptError = new Error("Apple Events refused");
    await expect(findTask("chrome-form").cleanup(context(mac))).rejects.toBe(mac.scriptError);
  });
  it("ignores only TextEdit's not-running error", async () => {
    const mac = new FakeMac();
    const path = "/eval/work/files/BBEval 메모.txt";
    mac.files.set(path, "test");
    mac.scriptError = new Error("Application isn't running. (-600)");
    await expect(findTask("textedit-append").cleanup(context(mac))).resolves.toBeUndefined();
    expect(mac.files.has(path)).toBe(false);
    mac.files.set(path, "test");
    mac.scriptError = new Error("Apple Events refused (-1743)");
    await expect(findTask("textedit-append").cleanup(context(mac))).rejects.toBe(mac.scriptError);
    expect(mac.files.has(path)).toBe(true);
  });
  it.each(["safari-read", "safari-navigate"])("tags %s titles and prompt", async (id) => {
    const mac = new FakeMac();
    const task = findTask(id);
    const vars = await task.setup(context(mac));
    expect(vars.tag).toMatch(/^[A-Z0-9]{4}$/);
    expect(promptFor(task, vars)).toBe(task.prompt.replaceAll("{tag}", vars.tag!));
    expect(promptFor(task, vars)).toContain(vars.tag!);
    for (const html of mac.files.values()) {
      expect(html.match(/<title>(.*?)<\/title>/)?.[1]).toContain(vars.tag!);
    }
    expect(promptFor(findTask("notes-read"), vars)).toBe(findTask("notes-read").prompt);
  });
  it.each([
    ["file:///eval/work/pages/done.html?name=%ED%99%8D%EA%B8%B8%EB%8F%99&choice=b", true],
    ["file:///eval/work/pages/done.html?choice=b&name=홍길동", true],
    ["file:///eval/work/pages/done.html?name=홍길동&choice=a", false],
    ["file:///elsewhere/done.html?name=홍길동&choice=b", false],
    ["not a URL", false],
  ])("parses Chrome submission %s", async (url, pass) => {
    const mac = new FakeMac();
    mac.scriptOutput = `https://example.com\n${url}`;
    const verdict = await findTask("chrome-form").judge(context(mac), "");
    expect(verdict.pass).toBe(pass);
    // The user's own tabs never reach the result.
    expect(verdict.detail).not.toContain("example.com");
  });
  it.each([
    ["BBEval 회의|2026-11-9T11:0:0|2026-11-9T12:0:0", true],
    ["BBEval 회의|2026-11-9T10:0:0|2026-11-9T11:0:0", false],
    ["BBEval 회의|2026-11-9T11:0:0|2026-11-9T13:0:0", false],
    [
      "BBEval 회의|2026-11-9T11:0:0|2026-11-9T12:0:0\nBBEval 회의|2026-11-9T11:0:0|2026-11-9T12:0:0",
      false,
    ],
  ])("judges Calendar move %s", async (output, pass) => {
    const mac = new FakeMac();
    mac.scriptOutput = output;
    expect((await findTask("calendar-move").judge(context(mac), "")).pass).toBe(pass);
  });
  it("checks Calendar creation time", async () => {
    const mac = new FakeMac();
    mac.scriptOutput = "BBEval 치과|2026-11-9T15:0:0|2026-11-9T16:0:0";
    expect((await findTask("calendar-create").judge(context(mac), "")).pass).toBe(true);
  });
  it.each([
    [false, "dark", "설명: light\n답: 다크", true],
    [false, "dark", "답: 다크 또는 라이트", false],
    [true, "dark", "답: 시스템", true],
    [true, "dark", "답: dark", false],
    [false, "light", "답: light", true],
  ])("judges Slack theme %s %s %s", async (sync, theme, answer, pass) => {
    const mac = new FakeMac();
    mac.files.set(
      slackPath,
      JSON.stringify({ settings: { systemThemeSyncEnabled: sync, userTheme: theme } }),
    );
    expect((await findTask("slack-theme").judge(context(mac), answer)).pass).toBe(pass);
  });
  it("requires Slack state and matches workspace domain case-insensitively", async () => {
    const mac = new FakeMac();
    await expect(findTask("slack-workspace").setup(context(mac))).rejects.toThrow("sign in");
    mac.files.set(slackPath, JSON.stringify({ workspaces: { one: { domain: "example" } } }));
    expect((await findTask("slack-workspace").judge(context(mac), "EXAMPLE.slack.com")).pass).toBe(
      true,
    );
  });
  it.each([
    ["답: EXAMPLE", true],
    ["답: https://EXAMPLE.slack.com/", true],
    ["답: (example.slack.com)", true],
    ["답: notexample", false],
    ["답: example-other", false],
    ["답: notexample.slack.com", false],
    ["답: example.slack.com.evil", false],
    ["example.slack.com\n답: unknown", false],
  ])("matches only workspace tokens in the answer line: %s", async (answer, pass) => {
    const mac = new FakeMac();
    mac.files.set(slackPath, JSON.stringify({ workspaces: { one: { domain: "example" } } }));
    expect((await findTask("slack-workspace").judge(context(mac), answer)).pass).toBe(pass);
  });
  it.each([
    ["1", "Dark", "답: 자동", true],
    ["0", "Dark", "답: dark", true],
    ["0", "", "답: 라이트", true],
    ["1", "Dark", "답: 자동 dark", false],
  ])("judges appearance %s %s", async (auto, style, answer, pass) => {
    const mac = new FakeMac();
    mac.runOutputs.set("defaults read -g AppleInterfaceStyleSwitchesAutomatically", auto);
    mac.runOutputs.set(
      "defaults read -g AppleInterfaceStyle",
      style || new Error("The domain/default pair does not exist"),
    );
    expect((await findTask("settings-appearance").judge(context(mac), answer)).pass).toBe(pass);
  });
  it("propagates unexpected defaults errors", async () => {
    const mac = new FakeMac();
    mac.runOutputs.set(
      "defaults read -g AppleInterfaceStyleSwitchesAutomatically",
      new Error("permission denied"),
    );
    await expect(findTask("settings-appearance").judge(context(mac), "light")).rejects.toThrow(
      "permission denied",
    );
  });
  it.each([
    ["안녕하세요\n테스트 완료\n", true],
    ["테스트 완료\n안녕하세요\n", false],
    ["테스트 완료", false],
  ])("checks saved TextEdit lines", async (text, pass) => {
    const mac = new FakeMac();
    mac.files.set("/eval/work/files/BBEval 메모.txt", text);
    expect((await findTask("textedit-append").judge(context(mac), "")).pass).toBe(pass);
  });
  it.each([
    ["26.5.2", "답: 26.5.2", true],
    ["26.5.0", "답: 26.5", true],
    ["26.5.2", "답: 26.5", false],
    ["26.5.2", "답: 126.5.20", false],
  ])("checks macOS version %s", async (version, answer, pass) => {
    const mac = new FakeMac();
    mac.runOutputs.set("sw_vers -productVersion", version);
    expect((await findTask("settings-macos-version").judge(context(mac), answer)).pass).toBe(pass);
  });
});

it("classifies failures in exported precedence order", () => {
  expect(FAILURE_RULE_ORDER).toEqual([
    "permission",
    "timeout",
    "ax_tree",
    "instruction",
    "wrong_action",
  ]);
  const classify = (transcript: string, timedOut: boolean) =>
    classifyFailure({ transcript, timedOut });
  expect(classify('permission_required "timeout"', true)).toBe("permission");
  expect(classify('computer_snapshot {"code":"timeout"}', false)).toBe("timeout");
  expect(classify("computer_click", true)).toBe("timeout");
  expect(classify("computer_snapshot stale_element", false)).toBe("ax_tree");
  expect(classify("no tools", false)).toBe("instruction");
  expect(classify('computer_snapshot agent: osascript could tell application "Notes"', false)).toBe(
    "wrong_action",
  );
  expect(
    classify('computer_snapshot {"type":"command_execution","text":"$ osascript -e ..."}', false),
  ).toBe("instruction");
  expect(
    classify(
      'computer_snapshot {"type":"command_execution","text":"$ echo tell application Notes"}',
      false,
    ),
  ).toBe("instruction");
  expect(classify("computer_snapshot\n$ /usr/bin/osascript -e ...", false)).toBe("instruction");
  for (const escaped of [false, true]) {
    const timeout = JSON.stringify({ code: "timeout" });
    const approval = JSON.stringify({ code: "timeout", details: { phase: "approval" } });
    const input = JSON.stringify({ timeout: 120000 });
    const encode = (text: string) => (escaped ? JSON.stringify(text) : text);
    expect(classify(`computer_snapshot ${encode(timeout)}`, false)).toBe("timeout");
    expect(classify(`computer_snapshot ${encode(approval)}`, false)).toBe("permission");
    expect(classify(`computer_snapshot ${encode(input)}`, false)).toBe("wrong_action");
  }
  expect(
    classify(
      '{"prompt":"Do not use AppleScript","tool":"computer_click","arguments":{"x":1}}',
      false,
    ),
  ).toBe("wrong_action");
  // Thread records carry "textTruncated" and the prompt's own tool rule; neither counts.
  expect(classify(`{"textTruncated":false,"text":"${TOOL_RULE}"} computer_click`, false)).toBe(
    "wrong_action",
  );
  expect(classify(`{"text":"${TOOL_RULE}"}`, false)).toBe("instruction");
  expect(classify('computer_snapshot {\\"truncated\\":\\"nodes\\"}', false)).toBe("ax_tree");
});

it("aggregates tasks, apps, failures, and replaces duplicate attempts", () => {
  const results: AttemptResult[] = [];
  for (const [taskId, app] of [
    ["notes-create", "Notes"],
    ["chrome-form", "Google Chrome"],
  ]) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      results.push({
        runId: "run",
        taskId: taskId!,
        app: app!,
        attempt,
        pass: attempt !== 2,
        ...(attempt === 2 ? { cause: "ax_tree" as const } : {}),
        detail: "",
        at: "2026-11-08",
      });
    }
  }
  const summary = summarize(results);
  expect(summary.overall).toEqual({ passes: 4, attempts: 6, percent: 66.7 });
  expect(summary.tasks["notes-create"]?.rate).toBe(2 / 3);
  expect(summary.apps.Notes?.attempts).toBe(3);
  expect(summary.causes.ax_tree).toBe(2);
  expect(renderReport(summary)).toContain("전체: 4/6 (66.7%)");
  expect(renderReport(summary)).toContain("✓✗✓");
  results.push({ ...results[1]!, pass: true });
  expect(summarize(results).overall).toEqual({ passes: 5, attempts: 6, percent: 83.3 });
  expect(summarize(results).causes.ax_tree).toBe(1);
  expect(summarize([]).overall.percent).toBe(0);
});

it("excludes harness errors from overall, task, and app rates", () => {
  const base: AttemptResult = {
    runId: "run",
    taskId: "safari-read",
    app: "Safari",
    attempt: 1,
    pass: true,
    detail: "",
    at: "2026-11-08",
  };
  const harness: AttemptResult = { ...base, attempt: 2, pass: false, cause: "harness" };
  const summary = summarize([
    base,
    harness,
    { ...base, attempt: 3, pass: false, cause: "wrong_action" },
    { ...harness, taskId: "calendar-create", app: "Calendar" },
  ]);
  expect(summary.overall).toEqual({ passes: 1, attempts: 2, percent: 50 });
  expect(summary.excluded).toEqual({
    count: 2,
    byTask: { "safari-read": 1, "calendar-create": 1 },
  });
  expect(summary.tasks["safari-read"]?.rate).toBe(0.5);
  expect(summary.apps.Safari).toEqual({ passes: 1, attempts: 2, rate: 0.5 });
  expect(summary.apps.Calendar).toEqual({ passes: 0, attempts: 0, rate: 0 });
  expect(summary.causes.harness).toBe(2);
  expect(renderReport(summary)).toContain("제외(실행기 오류): 2");
  expect(renderReport(summary)).toContain("| 실행기 오류 | 2 |");
  expect(summarize([harness]).overall).toEqual({ passes: 0, attempts: 0, percent: 0 });
  // A later valid judgment replaces the exclusion for the same attempt.
  expect(summarize([harness, { ...base, attempt: 2 }]).excluded.count).toBe(0);
});

describe("CLI", () => {
  const args = ["--base", "/eval", "--run", "run", "--attempt", "1"];
  it("parses arguments and rejects invalid values", async () => {
    expect(parseArgs(["judge", "notes-create", "--timed-out"]).options["timed-out"]).toBe(true);
    expect(() => parseArgs(["--base"])).toThrow("Missing value");
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown option");
    await expect(main(["report", "--run", "../escape"], new FakeMac(), () => {})).rejects.toThrow(
      "--run",
    );
  });
  it("runs setup, judge, and report through injected Mac", async () => {
    const mac = new FakeMac();
    const output: string[] = [];
    await main(["setup", "notes-read", ...args], mac, (s) => output.push(s));
    const state = JSON.parse(await mac.readFile("/eval/runs/run/state/notes-read-1.json"));
    expect(state.vars.code).toMatch(/^[A-Z0-9]{6}$/);
    mac.files.set("/answer", `답: ${state.vars.code}`);
    mac.files.set("/transcript", "computer_snapshot");
    await main(
      [
        "judge",
        "notes-read",
        ...args,
        "--answer-file",
        "/answer",
        "--transcript-file",
        "/transcript",
        "--thread-id",
        "thread",
      ],
      mac,
      (s) => output.push(s),
    );
    const result = JSON.parse(await mac.readFile("/eval/runs/run/results.jsonl"));
    expect(result.pass).toBe(true);
    expect(result.threadId).toBe("thread");
    await main(["report", "--base", "/eval", "--run", "run"], mac, (s) => output.push(s));
    expect(output.at(-1)).toContain("전체: 1/1 (100.0%)");
  });
  it("prints a tagged Safari prompt and preserves the verdict when cleanup is refused", async () => {
    const mac = new FakeMac();
    const output: string[] = [];
    mac.scriptError = new Error("Apple Events refused");
    await main(["setup", "safari-read", ...args], mac, (s) => output.push(s));
    const state = JSON.parse(await mac.readFile("/eval/runs/run/state/safari-read-1.json"));
    expect(JSON.parse(output.at(-1)!).prompt).toBe(promptFor(findTask("safari-read"), state.vars));
    expect(JSON.parse(output.at(-1)!).prompt).toContain(`BBEval 확인 코드 ${state.vars.tag}`);
    mac.files.set("/answer", `답: ${state.vars.code}`);
    await main(["judge", "safari-read", ...args, "--answer-file", "/answer"], mac, () => {});
    const result = JSON.parse(await mac.readFile("/eval/runs/run/results.jsonl"));
    expect(result.pass).toBe(true);
    expect(result.cause).toBeUndefined();
    expect(result.detail).toContain("; Safari tabs not closed: Error: Apple Events refused");
    expect(mac.files.has("/eval/work/pages/read.html")).toBe(false);
  });
  it("runs cleanup before setup without repeating cleanup in setup", async () => {
    const mac = new FakeMac();
    await main(["setup", "notes-read", ...args], mac, () => {});
    expect(mac.scripts).toHaveLength(3);
    expect(mac.scripts[0]).toContain("delete (every note");
    expect(mac.scripts[1]).toContain("delete (every note");
    expect(mac.scripts[2]).toContain("make new note");
  });
  it.each([false, true])(
    "cleans partial setup and preserves its error (cleanup fails: %s)",
    async (cleanupFails) => {
      const mac = new FakeMac();
      const error = new Error("open failed");
      vi.spyOn(mac, "osascript")
        .mockResolvedValueOnce("")
        .mockImplementationOnce(async () => {
          if (cleanupFails) {
            throw new Error("cleanup failed");
          }
          return "";
        });
      vi.spyOn(mac, "run").mockImplementationOnce(async () => {
        expect(mac.osascript).toHaveBeenCalledTimes(1);
        expect(mac.files.has("/eval/work/files/BBEval 메모.txt")).toBe(true);
        throw error;
      });
      await expect(main(["setup", "textedit-append", ...args], mac, () => {})).rejects.toBe(error);
      expect(mac.osascript).toHaveBeenCalledTimes(2);
      expect(mac.files.has("/eval/runs/run/state/textedit-append-1.json")).toBe(false);
      if (!cleanupFails) {
        expect(mac.files.has("/eval/work/files/BBEval 메모.txt")).toBe(false);
      }
    },
  );
  it("records harness failures and cleans up even when judging throws", async () => {
    const mac = new FakeMac();
    await main(["setup", "textedit-append", ...args], mac, () => {});
    mac.files.delete("/eval/work/files/BBEval 메모.txt");
    const scriptsBefore = mac.scripts.length;
    await main(["judge", "textedit-append", ...args], mac, () => {});
    const result = JSON.parse(await mac.readFile("/eval/runs/run/results.jsonl"));
    expect(result.cause).toBe("harness");
    expect(result.pass).toBe(false);
    expect(mac.scripts.length).toBe(scriptsBefore + 1);
    expect(mac.scripts.at(-1)).toContain("saving no");
  });
  it("records cleanup failures", async () => {
    const mac = new FakeMac();
    await main(["setup", "notes-read", ...args], mac, () => {});
    mac.scriptError = new Error("cleanup permission denied");
    await main(["judge", "notes-read", ...args], mac, () => {});
    const result = JSON.parse(await mac.readFile("/eval/runs/run/results.jsonl"));
    expect(result.cause).toBe("harness");
    expect(result.detail).toContain("cleanup failed");
  });
  it("lists and prints help without accessing apps", async () => {
    const mac = new FakeMac();
    const output: string[] = [];
    await main(["list"], mac, (s) => output.push(s));
    await main(["--help"], mac, (s) => output.push(s));
    expect(JSON.parse(output[0]!)).toHaveLength(13);
    expect(output[1]).toContain("10분");
    expect(mac.scripts).toHaveLength(0);
    expect(mac.calls).toHaveLength(0);
  });
});

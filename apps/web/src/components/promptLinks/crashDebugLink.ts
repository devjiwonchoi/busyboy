import {
  buildNewThreadLink,
  PROMPT_LINK_MAX_PROMPT_LENGTH,
  type PromptLinkRepository,
} from "@t3tools/shared/promptLinks";

const BUSYBOY_REPOSITORY: PromptLinkRepository = { owner: "devjiwonchoi", name: "busyboy" };

const TRUNCATED_MARKER = "\n[report truncated]";

export function crashDebugPrompt(report: string): string {
  const intro =
    "BusyBoy crashed with the error report below. Find the root cause in this repository and fix it.";
  const open = "\n\n```text\n";
  const close = "\n```";
  const room = PROMPT_LINK_MAX_PROMPT_LENGTH - intro.length - open.length - close.length;
  const body =
    report.length <= room
      ? report
      : report.slice(0, room - TRUNCATED_MARKER.length) + TRUNCATED_MARKER;
  return `${intro}${open}${body}${close}`;
}

/** The in-app path that opens a new BusyBoy chat on its own repository, primed to debug the crash. */
export function crashDebugLinkPath(report: string): string {
  const url = new URL(
    buildNewThreadLink({ prompt: crashDebugPrompt(report), repository: BUSYBOY_REPOSITORY }),
  );
  return `${url.pathname}${url.search}`;
}

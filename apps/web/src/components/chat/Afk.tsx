import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  afkActive,
  afkSetting,
  AuthOrchestrationOperateScope,
  type ProjectAfkAnswer,
  type ProjectTeamAfk,
  type ProjectTeamAttentionSummary,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, CoffeeIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { useEnvironmentIds } from "../../state/environments";
import { useProjectManagerEntries, useUpdateTeamSettings } from "../../state/projectTeam";
import { useEnvironmentsWithScope } from "../../state/session";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface AfkProps {
  projectRef: ScopedProjectRef;
  summary: ProjectTeamAttentionSummary;
}

/** Shown on a card the server answered while AFK was on. */
export const AFK_ANSWERED_LABEL = "자동 응답됨(AFK)";

function timeLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "6:30 PM", or "Sat 6:30 PM" when not today. */
function dateTimeLabel(date: Date, now: Date): string {
  if (date.toDateString() === now.toDateString()) return timeLabel(date);
  return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${timeLabel(date)}`;
}

/** "끌 때까지", or "6:30 PM까지" for a timed window turned on before the toggle. */
export function afkUntilLabel(setting: ProjectTeamAfk, now: Date = new Date()): string {
  if (setting.until === null) return "끌 때까지";
  return `${dateTimeLabel(new Date(setting.until), now)}까지`;
}

/** Whether AFK is on now; re-renders when a timed window ends. */
export function useAfkActive(setting: ProjectTeamAfk | undefined) {
  const [now, setNow] = useState(() => Date.now());
  const active = afkActive(setting, now);
  const until = setting?.until ?? null;
  useEffect(() => {
    if (!active || until === null) return;
    const remaining = Date.parse(until) - Date.now();
    // setTimeout overflows past ~24.8 days; timed windows lasted at most a week.
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, remaining) + 50);
    return () => window.clearTimeout(timer);
  }, [active, until]);
  return active;
}

/**
 * AFK for the whole workspace. The server keeps it per project, so turning it on or
 * off writes every project the user can operate, the Director included. It reads as
 * on while any project is AFK.
 */
export function useWorkspaceAfk() {
  const entries = useProjectManagerEntries(useEnvironmentIds());
  const operable = useEnvironmentsWithScope(entries, AuthOrchestrationOperateScope);
  const updateSettings = useUpdateTeamSettings();
  const now = Date.now();
  const targets = entries
    .filter((entry) => operable.has(entry.environmentId))
    .map((entry) => ({
      ref: scopeProjectRef(entry.environmentId, entry.summary.projectId),
      setting: afkSetting(entry.summary.settings),
    }));
  const on = entries.some((entry) => afkActive(afkSetting(entry.summary.settings), now));
  const setOn = (next: boolean) =>
    Promise.all(
      targets.flatMap(({ ref, setting }) => {
        if (next) {
          // Already on until turned off: nothing to write.
          if (setting?.until === null) return [];
          return [updateSettings(ref, { afk: { hours: null } })];
        }
        return setting === undefined ? [] : [updateSettings(ref, { afk: null })];
      }),
    );
  return { on, canToggle: targets.length > 0, setOn };
}

const AFK_HINT =
  "켜면 에이전트가 기다리지 않고 추천안으로 대신 답해요. 블로커·머지·시크릿은 기다려요.";

/**
 * The workspace AFK switch: an icon button at the bottom of the rail on desktop,
 * a chip in the sidebar's tab row on phones. Amber while on.
 */
export function AfkToggle({ compact }: { compact: boolean }) {
  const { on, canToggle, setOn } = useWorkspaceAfk();
  const button = (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="AFK"
      data-afk-toggle
      disabled={!canToggle}
      onClick={() => {
        void setOn(!on);
      }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        compact ? "h-9 gap-1.5 px-3 text-sm" : "size-9 flex-col gap-0.5 text-[9px] leading-none",
        on
          ? "bg-warning-surface text-warning-foreground ring-1 ring-warning/32"
          : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
      )}
    >
      <CoffeeIcon aria-hidden className="size-4" />
      AFK
    </button>
  );
  if (compact) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="right" className="max-w-56">
        <div className="font-medium">{on ? "AFK 켜짐" : "AFK 꺼짐"}</div>
        <div className="text-muted-foreground">{AFK_HINT}</div>
      </TooltipPopup>
    </Tooltip>
  );
}

function AfkAnswerRow({
  answer,
  projectRef,
}: { answer: ProjectAfkAnswer } & Pick<AfkProps, "projectRef">) {
  const at = new Date(answer.at);
  const body = (
    <>
      <span className="min-w-0 flex-1 break-words">{answer.text}</span>
      <time dateTime={answer.at} className="shrink-0 text-2xs opacity-75">
        {dateTimeLabel(at, new Date())}
      </time>
    </>
  );
  const rowClass = "flex items-start gap-2 rounded-md px-1.5 py-1";
  return (
    <li data-afk-answer={answer.id}>
      {answer.threadId === null ? (
        <div className={rowClass}>{body}</div>
      ) : (
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(scopeThreadRef(projectRef.environmentId, answer.threadId))}
          className={cn(rowClass, "hover:bg-warning/10")}
        >
          {body}
        </Link>
      )}
    </li>
  );
}

/**
 * A strip above the PM composer while AFK is on: when it ends, a button that turns it
 * off everywhere, and the questions answered for the user since it was turned on.
 */
export function AfkBanner({ projectRef, summary }: AfkProps) {
  const workspaceAfk = useWorkspaceAfk();
  const setting = afkSetting(summary.settings);
  const active = useAfkActive(setting);
  const [expanded, setExpanded] = useState(false);
  if (!active || setting === undefined) return null;
  const answers = [...summary.afkAnswers].reverse();

  return (
    <div
      role="status"
      aria-label="AFK"
      data-afk-banner
      className="mb-1.5 flex flex-col rounded-lg border border-warning/32 bg-warning-surface px-2.5 py-1 text-warning-foreground text-xs"
    >
      <div className="flex items-center gap-2">
        <CoffeeIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium">
          AFK 켜짐 · {afkUntilLabel(setting)}
        </span>
        {answers.length > 0 ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-expanded={expanded}
            className="shrink-0"
            onClick={() => setExpanded((value) => !value)}
          >
            {answers.length}개 자동 응답
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 transition-transform", expanded && "rotate-180")}
            />
          </Button>
        ) : null}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={!workspaceAfk.canToggle}
          className="shrink-0"
          onClick={() => {
            void workspaceAfk.setOn(false);
          }}
        >
          끄기
        </Button>
      </div>
      {expanded && answers.length > 0 ? (
        <ul aria-label="자동 응답" className="mt-1 mb-0.5 max-h-48 overflow-y-auto">
          {answers.map((answer) => (
            <AfkAnswerRow key={answer.id} answer={answer} projectRef={projectRef} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

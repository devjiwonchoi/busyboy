import { scopeThreadRef } from "@t3tools/client-runtime/environment";
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
import { useUpdateTeamSettings } from "../../state/projectTeam";
import { useEnvironmentScope } from "../../state/session";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";

interface AfkProps {
  projectRef: ScopedProjectRef;
  summary: ProjectTeamAttentionSummary;
}

/** Shown on a card the server answered while AFK was on. */
export const AFK_ANSWERED_LABEL = "Auto-answered (AFK)";

/** The choices the app offers; `hours: null` stays on until the user turns it off. */
export const AFK_CHOICES = [
  { id: "off", label: "Off", hours: undefined },
  { id: "1h", label: "1 hour", hours: 1 },
  { id: "8h", label: "8 hours", hours: 8 },
  { id: "24h", label: "24 hours", hours: 24 },
  { id: "until_off", label: "Until I turn it off", hours: null },
] as const;

function timeLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "6:30 PM", or "Sat 6:30 PM" when not today. */
function dateTimeLabel(date: Date, now: Date): string {
  if (date.toDateString() === now.toDateString()) return timeLabel(date);
  return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${timeLabel(date)}`;
}

/** "until 6:30 PM", "until Sat 6:30 PM" past today, or "until you turn it off". */
export function afkUntilLabel(setting: ProjectTeamAfk, now: Date = new Date()): string {
  if (setting.until === null) return "until you turn it off";
  return `until ${dateTimeLabel(new Date(setting.until), now)}`;
}

/** The menu choice that started this window; picking it again restarts the window. */
function selectedChoice(setting: ProjectTeamAfk): string | null {
  if (setting.until === null) return "until_off";
  const hours = Math.round((Date.parse(setting.until) - Date.parse(setting.since)) / 3_600_000);
  return AFK_CHOICES.find((choice) => choice.hours === hours)?.id ?? null;
}

/** Whether AFK is on now; re-renders when a timed window ends. */
export function useAfkActive(setting: ProjectTeamAfk | undefined) {
  const [now, setNow] = useState(() => Date.now());
  const active = afkActive(setting, now);
  const until = setting?.until ?? null;
  useEffect(() => {
    if (!active || until === null) return;
    const remaining = Date.parse(until) - Date.now();
    // setTimeout overflows past ~24.8 days; the app offers at most a week.
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, remaining) + 50);
    return () => window.clearTimeout(timer);
  }, [active, until]);
  return active;
}

/** The "AFK" section of the PM's composer settings menu. */
export function AfkSettings({ projectRef, summary }: AfkProps) {
  const canOperate = useEnvironmentScope(projectRef.environmentId, AuthOrchestrationOperateScope);
  const updateSettings = useUpdateTeamSettings();
  const setting = afkSetting(summary.settings);
  const active = useAfkActive(setting);
  const selected = !active || setting === undefined ? "off" : selectedChoice(setting);

  return (
    <div className="flex flex-col" data-afk-settings>
      <div className="px-2 pt-1.5 font-medium text-muted-foreground text-xs">AFK</div>
      <p className="px-2 pb-1.5 text-2xs text-muted-foreground">
        Agents take the recommended option instead of waiting for you. Blockers, merges and secrets
        still wait.
      </p>
      {active && setting !== undefined && setting.until !== null ? (
        <p className="px-2 pb-1 text-xs">On {afkUntilLabel(setting)}</p>
      ) : null}
      <div role="radiogroup" aria-label="AFK" className="flex flex-col">
        {AFK_CHOICES.map((choice) => (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={selected === choice.id}
            disabled={!canOperate}
            onClick={() => {
              void updateSettings(projectRef, {
                afk: choice.hours === undefined ? null : { hours: choice.hours },
              });
            }}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50",
              selected === choice.id && "font-medium",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full border border-muted-foreground/60",
                selected === choice.id && "border-primary bg-primary",
              )}
            />
            {choice.label}
          </button>
        ))}
      </div>
    </div>
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
 * A strip above the PM composer while AFK is on: when it ends, a Turn off button, and
 * the questions answered for the user since it was turned on.
 */
export function AfkBanner({ projectRef, summary }: AfkProps) {
  const canOperate = useEnvironmentScope(projectRef.environmentId, AuthOrchestrationOperateScope);
  const updateSettings = useUpdateTeamSettings();
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
          AFK on · {afkUntilLabel(setting)}
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
            {answers.length} auto-answered
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
          disabled={!canOperate}
          className="shrink-0"
          onClick={() => {
            void updateSettings(projectRef, { afk: null });
          }}
        >
          Turn off
        </Button>
      </div>
      {expanded && answers.length > 0 ? (
        <ul aria-label="Auto-answered" className="mt-1 mb-0.5 max-h-48 overflow-y-auto">
          {answers.map((answer) => (
            <AfkAnswerRow key={answer.id} answer={answer} projectRef={projectRef} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

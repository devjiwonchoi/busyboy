import {
  AuthOrchestrationOperateScope,
  autoApprovePlansActive,
  type ProjectTeamAttentionSummary,
  type ProjectTeamAutoApprovePlans,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { ShieldCheckIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { useUpdateTeamSettings } from "../../state/projectTeam";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";

interface AutoApprovePlansProps {
  projectRef: ScopedProjectRef;
  summary: ProjectTeamAttentionSummary;
}

/** The choices the app offers; `hours: null` stays on until the user turns it off. */
export const AUTO_APPROVE_PLANS_CHOICES = [
  { id: "off", label: "Off", hours: undefined },
  { id: "until_off", label: "Until I turn it off", hours: null },
  { id: "8h", label: "8 hours", hours: 8 },
  { id: "24h", label: "24 hours", hours: 24 },
] as const;

/** "until 6:30 PM", "until Sat 6:30 PM" past today, or "until you turn it off". */
export function autoApprovePlansUntilLabel(
  setting: ProjectTeamAutoApprovePlans,
  now: Date = new Date(),
): string {
  if (setting.until === null) return "until you turn it off";
  const until = new Date(setting.until);
  const sameDay = until.toDateString() === now.toDateString();
  const time = until.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay
    ? `until ${time}`
    : `until ${until.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** The menu choice that started this window; picking it again restarts the window. */
function selectedChoice(setting: ProjectTeamAutoApprovePlans): string | null {
  if (setting.until === null) return "until_off";
  const hours = Math.round((Date.parse(setting.until) - Date.parse(setting.since)) / 3_600_000);
  return AUTO_APPROVE_PLANS_CHOICES.find((choice) => choice.hours === hours)?.id ?? null;
}

/** Whether the setting is on now; re-renders when a timed window ends. */
export function useAutoApprovePlansActive(setting: ProjectTeamAutoApprovePlans | undefined) {
  const [now, setNow] = useState(() => Date.now());
  const active = autoApprovePlansActive(setting, now);
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

/** The "Auto-approve plans" section of the PM's composer settings menu. */
export function AutoApprovePlansSettings({ projectRef, summary }: AutoApprovePlansProps) {
  const canOperate = useEnvironmentScope(projectRef.environmentId, AuthOrchestrationOperateScope);
  const updateSettings = useUpdateTeamSettings();
  const setting = summary.settings.autoApprovePlans;
  const active = useAutoApprovePlansActive(setting);
  const selected = !active || setting === undefined ? "off" : selectedChoice(setting);

  return (
    <div className="flex flex-col" data-auto-approve-plans-settings>
      <div className="px-2 pt-1.5 font-medium text-muted-foreground text-xs">
        Auto-approve plans
      </div>
      <p className="px-2 pb-1.5 text-2xs text-muted-foreground">
        Plans waiting for approval start right away. Questions still come to you.
      </p>
      {active && setting !== undefined && setting.until !== null ? (
        <p className="px-2 pb-1 text-xs">On {autoApprovePlansUntilLabel(setting)}</p>
      ) : null}
      <div role="radiogroup" aria-label="Auto-approve plans" className="flex flex-col">
        {AUTO_APPROVE_PLANS_CHOICES.map((choice) => (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={selected === choice.id}
            disabled={!canOperate}
            onClick={() => {
              void updateSettings(projectRef, {
                autoApprovePlans: choice.hours === undefined ? null : { hours: choice.hours },
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

/** A strip above the PM composer while plans are auto-approved, with a Turn off button. */
export function AutoApprovePlansBanner({ projectRef, summary }: AutoApprovePlansProps) {
  const canOperate = useEnvironmentScope(projectRef.environmentId, AuthOrchestrationOperateScope);
  const updateSettings = useUpdateTeamSettings();
  const setting = summary.settings.autoApprovePlans;
  const active = useAutoApprovePlansActive(setting);
  if (!active || setting === undefined) return null;

  return (
    <div
      role="status"
      data-auto-approve-plans-banner
      className="mb-1.5 flex items-center gap-2 rounded-lg border border-warning/32 bg-warning-surface px-2.5 py-1 text-warning-foreground text-xs"
    >
      <ShieldCheckIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        Auto-approving plans {autoApprovePlansUntilLabel(setting)}
      </span>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={!canOperate}
        className="shrink-0"
        onClick={() => {
          void updateSettings(projectRef, { autoApprovePlans: null });
        }}
      >
        Turn off
      </Button>
    </div>
  );
}

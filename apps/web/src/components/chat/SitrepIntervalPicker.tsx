import {
  AuthOrchestrationOperateScope,
  MAX_PROJECT_TEAM_SITREP_INTERVAL_MINUTES,
  MIN_PROJECT_TEAM_SITREP_INTERVAL_MINUTES,
  type ProjectTeamAttentionSummary,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { useUpdateTeamSettings } from "../../state/projectTeam";
import { useEnvironmentScope } from "../../state/session";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  type ComposerControlSize,
} from "./ComposerControl";
import { AutoApprovePlansSettings } from "./AutoApprovePlans";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

export function formatSitrepInterval(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${rest}m`;
}

/** The server adapts the interval itself until the user saves one. */
function isAutoInterval(settings: ProjectTeamAttentionSummary["settings"]): boolean {
  return settings.intervalPinnedAt === undefined;
}

interface SitrepControlProps {
  projectRef: ScopedProjectRef;
  summary: ProjectTeamAttentionSummary;
}

export function SitrepSettingsContent({ projectRef, summary }: SitrepControlProps) {
  const { settings } = summary;
  const canOperate = useEnvironmentScope(projectRef.environmentId, AuthOrchestrationOperateScope);
  const updateSettings = useUpdateTeamSettings();
  // Null until the user types, so a server-side change shows without wiping a draft.
  const [typed, setTyped] = useState<string | null>(null);
  // Escape and unmount can both save before a re-render; send each draft once.
  const sent = useRef<string | null>(null);
  const draft = typed ?? String(settings.sitrepIntervalMinutes);
  const minutes = Number(draft);
  const valid =
    /^\d+$/.test(draft) &&
    minutes >= MIN_PROJECT_TEAM_SITREP_INTERVAL_MINUTES &&
    minutes <= MAX_PROJECT_TEAM_SITREP_INTERVAL_MINUTES;
  // Saving pins the interval, so closing only saves a changed value;
  // Enter on the same value pins a server-chosen interval on purpose.
  const save = (explicit: boolean) => {
    if (!canOperate || !valid || typed === null || typed === sent.current) return;
    if (minutes === settings.sitrepIntervalMinutes && (!explicit || !isAutoInterval(settings))) {
      return;
    }
    sent.current = typed;
    setTyped(null);
    void updateSettings(projectRef, { sitrepIntervalMinutes: minutes });
  };
  // Phones have no Enter on the number pad, and a tap outside closes the popover
  // without blurring the input, so a typed value is also saved when the field unmounts.
  const saveOnUnmount = useRef(save);
  saveOnUnmount.current = save;
  useEffect(() => () => saveOnUnmount.current(false), []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      save(false);
      return;
    }
    // Menus treat typed keys as typeahead.
    event.stopPropagation();
    if (event.key !== "Enter") return;
    event.preventDefault();
    save(true);
  };

  return (
    <div className="flex flex-col">
      <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Sitrep every</div>
      <label className="flex items-center gap-2 px-2 pb-2 text-muted-foreground text-xs">
        <Input
          nativeInput
          size="compact"
          type="number"
          inputMode="numeric"
          min={MIN_PROJECT_TEAM_SITREP_INTERVAL_MINUTES}
          max={MAX_PROJECT_TEAM_SITREP_INTERVAL_MINUTES}
          aria-label="Sitrep interval in minutes"
          aria-invalid={!valid || undefined}
          disabled={!canOperate}
          value={draft}
          onChange={(event) => {
            sent.current = null;
            setTyped(event.currentTarget.value.trim());
          }}
          onKeyDown={onKeyDown}
          onBlur={() => save(false)}
          className="w-20"
        />
        minutes
      </label>
      <Separator className="my-1" />
      <label className="flex cursor-pointer items-center justify-between gap-4 px-2 py-1.5 text-sm">
        Sitrep notifications
        <Switch
          size="sm"
          checked={settings.sitrepNotify}
          disabled={!canOperate}
          onCheckedChange={(checked) => {
            void updateSettings(projectRef, { sitrepNotify: checked });
          }}
        />
      </label>
      <Separator className="my-1" />
      <AutoApprovePlansSettings projectRef={projectRef} summary={summary} />
    </div>
  );
}

export function SitrepIntervalPicker(
  props: SitrepControlProps & { size?: ComposerControlSize; hidden?: boolean },
) {
  const size = props.size ?? "sm";
  const { settings } = props.summary;
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const label = `Sitrep ${formatSitrepInterval(settings.sitrepIntervalMinutes)}`;
  const auto = isAutoInterval(settings);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <ComposerControl
            size={size}
            aria-label={auto ? `${label}, auto` : label}
            className="shrink-0 whitespace-nowrap"
          />
        }
      >
        <ComposerControlIcon icon={RefreshCwIcon} size={size} />
        <span data-composer-control-label>
          {label}
          {auto ? <span className="ms-1 text-2xs text-muted-foreground">auto</span> : null}
        </span>
        <ComposerControlChevron size={size} />
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        padding="compact"
        className="w-56"
        {...composerFloatingLayerProps}
      >
        <SitrepSettingsContent projectRef={props.projectRef} summary={props.summary} />
      </PopoverPopup>
    </Popover>
  );
}

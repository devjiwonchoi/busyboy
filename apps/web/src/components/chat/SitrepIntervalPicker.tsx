import {
  AuthOrchestrationOperateScope,
  MAX_PROJECT_TEAM_SITREP_INTERVAL_MINUTES,
  MIN_PROJECT_TEAM_SITREP_INTERVAL_MINUTES,
  type ProjectTeamAttentionSummary,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

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
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

export function formatSitrepInterval(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${rest}m`;
}

/** The server picks the interval itself unless the user saved one in the last 24 hours. */
function isAutoInterval(settings: ProjectTeamAttentionSummary["settings"]): boolean {
  return settings.pinnedUntil === undefined || Date.parse(settings.pinnedUntil) <= Date.now();
}

interface SitrepControlProps {
  projectRef: ScopedProjectRef;
  summary: ProjectTeamAttentionSummary;
}

export function SitrepSettingsContent(props: SitrepControlProps) {
  const { settings } = props.summary;
  // Remounting on a new saved value resets the draft.
  return <SitrepSettingsFields key={settings.sitrepIntervalMinutes} {...props} />;
}

function SitrepSettingsFields({ projectRef, summary: { settings } }: SitrepControlProps) {
  const canOperate = useEnvironmentScope(projectRef.environmentId, AuthOrchestrationOperateScope);
  const updateSettings = useUpdateTeamSettings();
  const [draft, setDraft] = useState(String(settings.sitrepIntervalMinutes));
  const minutes = Number(draft);
  const valid =
    /^\d+$/.test(draft) &&
    minutes >= MIN_PROJECT_TEAM_SITREP_INTERVAL_MINUTES &&
    minutes <= MAX_PROJECT_TEAM_SITREP_INTERVAL_MINUTES;
  // Saving pins the interval for 24 hours, so blur only saves a changed value;
  // Enter on the same value pins a server-chosen interval on purpose.
  const save = (explicit: boolean) => {
    if (!canOperate || !valid) return;
    if (minutes === settings.sitrepIntervalMinutes && (!explicit || !isAutoInterval(settings))) {
      return;
    }
    void updateSettings(projectRef, { sitrepIntervalMinutes: minutes });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
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
          onChange={(event) => setDraft(event.currentTarget.value.trim())}
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

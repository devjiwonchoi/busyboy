import {
  AuthOrchestrationOperateScope,
  type ProjectManagerVoice,
  type ProjectTeamAttentionSummary,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { lazy, Suspense, useState } from "react";

import { useProjectManager, useUpdateTeamSettings } from "../../state/projectTeam";
import { useEnvironmentScope } from "../../state/session";
import { ProjectIconGlyph } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

const NAME_MAX_LENGTH = 40;
const VOICE_CUSTOM_MAX_LENGTH = 500;
const VOICES: ReadonlyArray<{ value: ProjectManagerVoice; label: string }> = [
  { value: "chill", label: "Chill" },
  { value: "dry", label: "Dry" },
  { value: "chatty", label: "Chatty" },
  { value: "custom", label: "Custom" },
];

const TASK_KEY_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,5}$/;

function isVoice(value: unknown): value is ProjectManagerVoice {
  return VOICES.some((voice) => voice.value === value);
}

/** The project's manager section, shown once the project has a PM. */
export function ProjectManagerSettings(props: { projectRef: ScopedProjectRef }) {
  const summary = useProjectManager(props.projectRef);
  if (summary === null) return null;
  return <ProjectManagerSettingsSection projectRef={props.projectRef} summary={summary} />;
}

export function ProjectManagerSettingsSection(props: {
  projectRef: ScopedProjectRef;
  summary: ProjectTeamAttentionSummary;
}) {
  const { projectRef, summary } = props;
  const { persona } = summary;
  const canOperate = useEnvironmentScope(projectRef.environmentId, AuthOrchestrationOperateScope);
  const updateSettings = useUpdateTeamSettings();
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  // Custom shows its text box at once; the server's next summary takes over.
  const [pendingVoice, setPendingVoice] = useState<{
    from: ProjectManagerVoice;
    to: ProjectManagerVoice;
  } | null>(null);
  const voice = pendingVoice?.from === persona.voice ? pendingVoice.to : persona.voice;

  const saveName = (input: HTMLInputElement) => {
    const name = input.value.trim();
    if (name === persona.name) return;
    if (name.length === 0) {
      toastManager.add({ type: "warning", title: "The project manager needs a name" });
      input.value = persona.name;
      return;
    }
    void updateSettings(projectRef, { persona: { name } });
  };
  const saveTaskKeyPrefix = (input: HTMLInputElement) => {
    const prefix = input.value.trim().toUpperCase();
    if (prefix === summary.taskKeyPrefix) {
      input.value = prefix;
      return;
    }
    if (!TASK_KEY_PREFIX_PATTERN.test(prefix)) {
      toastManager.add({
        type: "warning",
        title: "Use 1 to 6 capital letters or digits, starting with a letter",
      });
      input.value = summary.taskKeyPrefix;
      return;
    }
    void updateSettings(projectRef, { taskKeyPrefix: prefix });
  };
  const saveVoice = (next: ProjectManagerVoice) => {
    if (next === voice) return;
    setPendingVoice({ from: persona.voice, to: next });
    void updateSettings(projectRef, { persona: { voice: next } });
  };
  const saveVoiceCustom = (value: string) => {
    const voiceCustom = value.trim();
    if (voiceCustom === (persona.voiceCustom ?? "") && persona.voice === "custom") return;
    void updateSettings(projectRef, { persona: { voice: "custom", voiceCustom } });
  };

  return (
    <SettingsSection id="project-manager" title="Project manager">
      <SettingsRow
        title="Project manager"
        description="Runs the project's tasks, keeps you posted with sitreps and asks when it needs you."
        control={
          <Switch
            size="sm"
            checked={summary.enabled}
            disabled={!canOperate}
            aria-label="Project manager"
            onCheckedChange={(checked) => void updateSettings(projectRef, { enabled: checked })}
          />
        }
      />
      {summary.enabled ? (
        <>
          <SettingsRow
            title="Name"
            description={`You can also just tell ${persona.name} in chat.`}
            control={
              <Input
                key={persona.name}
                size="sm"
                className="w-full sm:w-64"
                aria-label="Project manager name"
                maxLength={NAME_MAX_LENGTH}
                disabled={!canOperate}
                defaultValue={persona.name}
                onBlur={(event) => saveName(event.currentTarget)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            }
          />
          <SettingsRow
            title="Task key prefix"
            description={`Tasks are named like ${summary.taskKeyPrefix}-7. It comes from the project name until you change it.`}
            control={
              <Input
                key={summary.taskKeyPrefix}
                size="sm"
                className="w-full font-mono uppercase sm:w-28"
                aria-label="Task key prefix"
                maxLength={6}
                disabled={!canOperate}
                defaultValue={summary.taskKeyPrefix}
                onBlur={(event) => saveTaskKeyPrefix(event.currentTarget)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            }
          />
          <SettingsRow
            title="Avatar"
            description="An emoji, icon or monogram."
            control={
              <div className="flex items-center gap-2">
                <span className="inline-flex size-7 items-center justify-center rounded-full border border-border/70 bg-muted">
                  <ProjectIconGlyph icon={persona.avatar} className="size-4.5" />
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  aria-label="Choose an avatar"
                  disabled={!canOperate}
                  onClick={() => setAvatarPickerOpen(true)}
                >
                  Choose avatar
                </Button>
              </div>
            }
          />
          <SettingsRow
            title="Voice"
            description="How the project manager sounds in chat and sitreps."
            control={
              <ToggleGroup
                aria-label="Project manager voice"
                value={[voice]}
                disabled={!canOperate}
                onValueChange={(values) => {
                  const next = values[0];
                  if (isVoice(next)) saveVoice(next);
                }}
              >
                {VOICES.map((option) => (
                  <Toggle key={option.value} value={option.value}>
                    {option.label}
                  </Toggle>
                ))}
              </ToggleGroup>
            }
          >
            {voice === "custom" ? (
              <div className="pb-3">
                <Textarea
                  key={persona.voiceCustom ?? ""}
                  aria-label="Custom voice"
                  placeholder="Describe how the project manager should sound."
                  maxLength={VOICE_CUSTOM_MAX_LENGTH}
                  disabled={!canOperate}
                  defaultValue={persona.voiceCustom ?? ""}
                  onBlur={(event) => saveVoiceCustom(event.currentTarget.value)}
                />
              </div>
            ) : null}
          </SettingsRow>
        </>
      ) : null}
      {avatarPickerOpen && canOperate ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={persona.avatar}
            projectName={persona.name}
            open
            onOpenChange={setAvatarPickerOpen}
            onSelect={(avatar) => void updateSettings(projectRef, { persona: { avatar } })}
          />
        </Suspense>
      ) : null}
    </SettingsSection>
  );
}

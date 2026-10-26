import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { AppText as Text } from "../../components/ui/AppText";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";

export function SettingsThreadsRouteScreen() {
  const insets = useSafeAreaInsets();

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Thread behavior" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <UsageLimitSettingsRows />
          <BetaSettingsSection />
          <LegacySettingsSection />
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function UsageLimitSettingsRows() {
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  const [pendingTargets, setPendingTargets] = useState<
    readonly ScopedMobileSettingsTarget[] | null
  >(null);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "server settings update",
    reportFailure: true,
  });

  const syncTargets = resolveMobileSettingsTargets(
    selectedTargets.filter(supportsSharedSettingsSync),
    null,
  );
  const canWriteSettings =
    syncTargets.length > 0 &&
    syncTargets.every((target) => writableEnvironments.has(target.environment.environmentId));
  const displayTargets =
    pendingWrites > 0 && pendingTargets !== null ? pendingTargets : syncTargets;

  // Usage-limit settings are server-wide, so a selected project has nothing to show here.
  if (selectedProjectKey !== null || displayTargets.length === 0) {
    return null;
  }

  const writeToAll = (patch: {
    autoResumeLimitedThreads?: boolean;
    snoozeLimitedThreads?: boolean;
  }) => {
    if (
      writeInFlight.current ||
      !syncTargets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planMobileScopedSettingsPatch(syncTargets, false, patch);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(syncTargets);
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      writes.map((entry) =>
        updateSettings({ environmentId: entry.environmentId, input: { patch: entry.patch } }),
      ),
    ).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };

  const disabled = !canWriteSettings || pendingWrites > 0;

  return (
    <SettingsSection title="Usage limits">
      <SettingsSwitchRow
        icon="clock"
        label="Auto-resume limited threads"
        value={uniformMobileSetting(displayTargets, "autoResumeLimitedThreads")}
        disabled={disabled}
        onValueChange={(value) => writeToAll({ autoResumeLimitedThreads: value })}
      />
      <SettingsSwitchRow
        icon="clock"
        label="Snooze limited threads"
        value={uniformMobileSetting(displayTargets, "snoozeLimitedThreads")}
        disabled={disabled}
        onValueChange={(value) => writeToAll({ snoozeLimitedThreads: value })}
      />
    </SettingsSection>
  );
}

function BetaSettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const workingShelfEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.workingShelfEnabled === true;

  return (
    <View className="gap-3">
      <SettingsSection title="Beta">
        <SettingsSwitchRow
          icon="bolt.circle"
          label="Working section"
          value={workingShelfEnabled}
          onValueChange={(value) => savePreferences({ workingShelfEnabled: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Fold working and monitoring threads into a Working section. They return to the top of the
        list when they need you. While this is on, active threads are ordered by time and cannot be
        moved.
      </Text>
    </View>
  );
}

function LegacySettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const planModeEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.planModeEnabled === true;

  return (
    <View className="gap-3">
      <SettingsSection title="Legacy">
        <SettingsSwitchRow
          icon="hammer"
          label="Plan Mode"
          value={planModeEnabled}
          onValueChange={(value) => savePreferences({ planModeEnabled: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Opt into retired interfaces kept for compatibility. Plan Mode restores the Build/Plan
        control; otherwise every task runs in Build mode.
      </Text>
    </View>
  );
}

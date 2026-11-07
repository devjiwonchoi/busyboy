import { useAtomValue } from "@effect/atom-react";
import { AuthEnvironmentMaintainScope, type DesktopUpdateState } from "@t3tools/contracts";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerConfigAtom, serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useServerUpdate } from "../ServerUpdateAction";
import { Button } from "../ui/button";
import { SidebarMenuItem } from "../ui/sidebar";

export type PhoneDesktopUpdateView =
  | { readonly kind: "hidden" }
  | { readonly kind: "status"; readonly label: string }
  | { readonly kind: "ready"; readonly label: string; readonly version: string };

/**
 * Mirrors the desktop app's own install admission: a download survives an
 * unrelated background error and a failed install, and a version that already
 * failed to apply is retried only from the Mac itself.
 */
export function describePhoneDesktopUpdate(
  state: DesktopUpdateState | null,
  updateState: ServerUpdateState,
): PhoneDesktopUpdateView {
  if (updateState.status === "running") {
    return { kind: "status", label: "데스크톱 앱 재시작 중…" };
  }
  if (state === null || !state.enabled || state.status === "disabled") return { kind: "hidden" };
  const downloaded = state.downloadedVersion;
  if (
    downloaded !== null &&
    state.notAppliedVersion !== downloaded &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return { kind: "ready", label: `데스크톱 앱 ${downloaded} 준비됨`, version: downloaded };
  }
  switch (state.status) {
    case "available":
    case "downloading":
      return {
        kind: "status",
        label:
          state.downloadPercent === null
            ? "데스크톱 앱 업데이트 다운로드 중"
            : `데스크톱 앱 업데이트 다운로드 중 ${Math.floor(state.downloadPercent)}%`,
      };
    case "checking":
      return { kind: "status", label: "데스크톱 앱 업데이트 확인 중" };
    case "idle":
    case "up-to-date":
      return { kind: "status", label: `데스크톱 앱 최신 (${state.currentVersion})` };
    default:
      return { kind: "hidden" };
  }
}

/**
 * Lets a phone install the update the Mac's desktop app already downloaded.
 * The install runs the same prepare → commit path as remote server updates,
 * which ends in the desktop's verified quitAndInstall.
 */
export function PhoneDesktopUpdatePill() {
  const environment = usePrimaryEnvironment();
  const environmentId = environment?.environmentId ?? null;
  const config = useAtomValue(primaryServerConfigAtom);
  const supported = config?.environment.capabilities.desktopAppUpdate === true;
  const canMaintain = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const query = useEnvironmentQuery(
    environmentId !== null && supported && canMaintain
      ? serverEnvironment.desktopUpdateState({ environmentId, input: {} })
      : null,
  );
  const updateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const update = useServerUpdate();
  const [pending, setPending] = useState(false);

  if (environmentId === null || !supported || !canMaintain) return null;
  const view = describePhoneDesktopUpdate(query.data ?? null, updateState);
  if (view.kind === "hidden") return null;

  const install = async (version: string) => {
    if (pending) return;
    const message = `Mac의 BusyBoy 데스크톱 앱을 ${version}로 업데이트할까요? 앱이 닫혔다가 다시 켜지고, 폰은 자동으로 다시 연결돼요.`;
    const confirmed = (await requestConfirmDialog(message)) ?? window.confirm(message);
    if (!confirmed) return;
    setPending(true);
    await update({
      environmentId,
      serverLabel: environment?.label ?? "데스크톱 앱",
      selfUpdate: "desktop-managed",
      desktopAppUpdate: true,
      targetVersion: version,
    });
    setPending(false);
  };

  return (
    <SidebarMenuItem className="ml-auto flex min-w-0 flex-1">
      <div
        data-testid="phone-desktop-update"
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full bg-sidebar-control-surface pr-1 pl-3 text-xs text-sidebar-foreground"
      >
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            view.kind === "status" && "text-muted-foreground",
          )}
        >
          {view.label}
        </span>
        {view.kind === "ready" ? (
          <Button
            size="xs"
            className="shrink-0 rounded-full"
            disabled={pending}
            onClick={() => void install(view.version)}
          >
            재시작해서 업데이트
          </Button>
        ) : null}
      </div>
    </SidebarMenuItem>
  );
}

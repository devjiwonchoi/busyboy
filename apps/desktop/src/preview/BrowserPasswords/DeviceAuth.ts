export type DeviceAuthAction = "reveal" | "copy" | "deleteAll" | "fill";

export interface DeviceAuthRequest {
  readonly action: DeviceAuthAction;
  /** Site label, e.g. `example.com`; absent for whole-vault actions. */
  readonly site?: string | undefined;
}

/**
 * Asks the person at the machine to confirm. Touch ID when the Mac can prompt
 * for it, otherwise a native confirm that says Touch ID is unavailable.
 * Resolves false on cancel or failure, never rejects.
 */
export interface DeviceAuthGate {
  readonly touchIdAvailable: () => boolean;
  readonly authorize: (request: DeviceAuthRequest) => Promise<boolean>;
}

/** The text shown after "BusyBoy is trying to…" in the Touch ID sheet. */
export function deviceAuthReason(request: DeviceAuthRequest): string {
  const site = request.site ?? "this site";
  switch (request.action) {
    case "reveal":
      return `reveal the saved password for ${site}`;
    case "copy":
      return `copy the saved password for ${site}`;
    case "fill":
      return `fill your saved password on ${site}`;
    case "deleteAll":
      return "delete all saved passwords";
  }
}

export interface ElectronDeviceAuthDeps {
  readonly platform: NodeJS.Platform;
  readonly canPromptTouchID: () => boolean;
  readonly promptTouchID: (reason: string) => Promise<void>;
  /** Native modal; resolves with the clicked button index. */
  readonly confirm: (options: {
    readonly message: string;
    readonly detail: string;
    readonly confirmLabel: string;
  }) => Promise<boolean>;
}

export function makeDeviceAuthGate(deps: ElectronDeviceAuthDeps): DeviceAuthGate {
  const touchIdAvailable = () => {
    if (deps.platform !== "darwin") return false;
    try {
      return deps.canPromptTouchID();
    } catch {
      return false;
    }
  };
  return {
    touchIdAvailable,
    authorize: async (request) => {
      const reason = deviceAuthReason(request);
      try {
        if (touchIdAvailable()) {
          await deps.promptTouchID(reason);
          return true;
        }
        return await deps.confirm({
          message: "Touch ID unavailable",
          detail: `Confirm that you want to ${reason}.`,
          confirmLabel: request.action === "deleteAll" ? "Delete all" : "Continue",
        });
      } catch {
        return false;
      }
    },
  };
}

import {
  PASSWORD_IMPORT_FAILURE_COPY,
  PasswordImportFailureReason,
  type ChromePasswordSource,
  type PasswordFileImportResult,
  type PasswordFileImportSourceId,
  type PasswordImportResult,
  type PasswordImportSourceId,
} from "@t3tools/contracts";
import { useEffect, useState, type ReactNode } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";

import { refreshSavedPasswordStatus, useSavedPasswordStatus } from "./savedPasswordStatusStore";

export const passwordImportFailureCopy = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : String(cause);
  const reason = PasswordImportFailureReason.literals.find((candidate) =>
    message.includes(`failed: ${candidate}.`),
  );
  return PASSWORD_IMPORT_FAILURE_COPY[reason ?? "readFailed"];
};

export const passwordImportSummary = (result: PasswordImportResult): string => {
  const details = [
    result.updated > 0 ? `${result.updated.toLocaleString()} updated` : null,
    result.skipped > 0 ? `${result.skipped.toLocaleString()} skipped` : null,
  ].filter((detail) => detail !== null);
  const imported = `${result.imported.toLocaleString()} new ${result.imported === 1 ? "password" : "passwords"}`;
  return details.length === 0 ? imported : `${imported} (${details.join(", ")})`;
};

const SOURCE_NAMES: Record<PasswordImportSourceId, string> = {
  chrome: "Chrome",
  applePasswords: "Apple Passwords",
  "1password": "1Password",
};

function SourceSection({
  title,
  badge,
  children,
}: {
  readonly title: string;
  readonly badge: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <h3 className="font-medium text-sm">{title}</h3>
        {badge}
      </div>
      {children}
    </section>
  );
}

export function PasswordImportDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const status = useSavedPasswordStatus(open);
  const [chromeSource, setChromeSource] = useState<ChromePasswordSource | null>(null);
  const [importing, setImporting] = useState<PasswordImportSourceId | null>(null);

  useEffect(() => {
    if (!open || !previewBridge) {
      return;
    }
    setChromeSource(null);
    void previewBridge
      .getChromePasswordSource()
      .then(setChromeSource)
      .catch(() => setChromeSource({ profiles: [], unavailable: "unsupportedPlatform" }));
  }, [open]);

  const runImport = async (
    sourceId: PasswordImportSourceId,
    run: () => Promise<PasswordImportResult | PasswordFileImportResult | null>,
  ) => {
    setImporting(sourceId);
    try {
      const result = await run();
      if (result === null) {
        return;
      }
      const trashed =
        "exportTrashed" in result && result.exportTrashed
          ? " The exported file was moved to the Trash."
          : "";
      toastManager.add({
        type: "success",
        title: `Imported passwords from ${SOURCE_NAMES[sourceId]}`,
        description: `${passwordImportSummary(result)}.${trashed}`,
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Could not import from ${SOURCE_NAMES[sourceId]}`,
        description: passwordImportFailureCopy(cause),
      });
    } finally {
      setImporting(null);
      await refreshSavedPasswordStatus();
    }
  };

  const importChrome = (sourceProfileDirectory: string) => {
    const bridge = previewBridge;
    if (bridge) {
      void runImport("chrome", () => bridge.importChromePasswords({ sourceProfileDirectory }));
    }
  };

  const importFile = (sourceId: PasswordFileImportSourceId) => {
    const bridge = previewBridge;
    if (bridge) {
      void runImport(sourceId, () => bridge.importPasswordFile({ sourceId }));
    }
  };

  const openPasswordsApp = () => {
    void previewBridge?.openPasswordsApp().then((opened) => {
      if (!opened) {
        toastManager.add({
          type: "error",
          title: "Could not open Passwords",
          description: "Open the Passwords app yourself, then export from its File menu.",
        });
      }
    });
  };

  const busy = importing !== null;
  const spinnerFor = (sourceId: PasswordImportSourceId) =>
    importing === sourceId ? <Spinner className="size-3.5" /> : null;
  const chromeSync = status?.chromeSync ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import passwords</DialogTitle>
          <DialogDescription>
            Saved logins fill in automatically in the in-app browser, so agents can sign in without
            ever seeing your passwords. They stay encrypted on this Mac.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <SourceSection
            title="Chrome"
            badge={
              chromeSync ? (
                <Badge variant="outline">Syncing · {chromeSync.profileName}</Badge>
              ) : null
            }
          >
            <p className="text-muted-foreground text-sm">
              Imports now and keeps syncing in the background. Chrome can stay open; macOS asks for
              Keychain access once.
            </p>
            <div className="flex flex-wrap gap-2">
              {chromeSource === null ? (
                <Button size="sm" variant="outline" disabled>
                  <Spinner className="size-3.5" />
                  Looking for Chrome…
                </Button>
              ) : chromeSource.unavailable !== undefined ? (
                <p className="text-muted-foreground text-sm">
                  {PASSWORD_IMPORT_FAILURE_COPY[chromeSource.unavailable]}
                </p>
              ) : (
                chromeSource.profiles.map((profile) => (
                  <Button
                    key={profile.directory}
                    size="sm"
                    disabled={busy}
                    onClick={() => importChrome(profile.directory)}
                  >
                    {spinnerFor("chrome")}
                    {chromeSync ? "Sync now" : "Import from Chrome"}
                    {chromeSource.profiles.length > 1 ? ` — ${profile.name}` : ""}
                  </Button>
                ))
              )}
            </div>
          </SourceSection>
          <SourceSection title="Apple Passwords" badge={null}>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground text-sm">
              <li>Open the Passwords app.</li>
              <li>Choose File → Export All Passwords to File… and save it.</li>
              <li>Choose that file here. It moves to the Trash once imported.</li>
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={openPasswordsApp}>
                Open Passwords
              </Button>
              <Button size="sm" disabled={busy} onClick={() => importFile("applePasswords")}>
                {spinnerFor("applePasswords")}
                Choose exported file…
              </Button>
            </div>
          </SourceSection>
          <SourceSection title="1Password" badge={null}>
            <p className="text-muted-foreground text-sm">
              In 1Password, choose File → Export, pick your account and the CSV format, then choose
              that file here. It moves to the Trash once imported.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => importFile("1password")}>
                {spinnerFor("1password")}
                Choose exported file…
              </Button>
            </div>
          </SourceSection>
        </DialogPanel>
        <DialogFooter variant="bare">
          <p className="mr-auto text-muted-foreground text-sm">
            {status === null
              ? null
              : `${status.count.toLocaleString()} saved ${status.count === 1 ? "password" : "passwords"}`}
          </p>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

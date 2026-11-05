import type {
  BrowserPasswordImportFailure,
  BrowserPasswordImportSourceProfile,
  BrowserPasswordImportSummary,
  DesktopBrowserPasswordsBridge,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export const IMPORT_FAILURE_MESSAGES: Readonly<Record<BrowserPasswordImportFailure, string>> = {
  needsKeychainApproval:
    "macOS didn't get permission to read Chrome's passwords. Choose Allow when it asks, then try again.",
  keychainItemMissing:
    "Chrome's “Chrome Safe Storage” key wasn't found in your keychain. Open Chrome once, then try again.",
  keychainUnavailable: "Your keychain couldn't be reached. Unlock it, then try again.",
  unsupportedPlatform: "Importing passwords from Chrome isn't supported on this system.",
  unknownSourceProfile: "That Chrome profile is no longer there. Pick another.",
  readFailed: "Chrome's passwords couldn't be read. Try again.",
  unavailable: "Passwords can't be saved in this profile right now.",
};

export function summaryLines(summary: BrowserPasswordImportSummary): string[] {
  const plural = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  return [
    `Imported ${plural(summary.imported, "password", "passwords")}`,
    ...(summary.updated > 0 ? [`Updated ${summary.updated}`] : []),
    ...(summary.skipped > 0 ? [`Skipped ${summary.skipped} already saved`] : []),
    ...(summary.failed > 0 ? [`${summary.failed} couldn't be decrypted`] : []),
    ...(summary.neverSave > 0
      ? [`Added ${plural(summary.neverSave, "site", "sites")} to “Never saved”`]
      : []),
  ];
}

/**
 * Settings → Passwords → Import from Chrome. macOS asks the person to allow
 * access to Chrome's key; BusyBoy never sees or shows a password here.
 */
export function ChromePasswordImportDialog(props: {
  readonly bridge: DesktopBrowserPasswordsBridge;
  readonly profileId: string;
  readonly profileName: string;
  readonly onClose: () => void;
}) {
  const { bridge, profileId, onClose } = props;
  const [sources, setSources] = useState<ReadonlyArray<BrowserPasswordImportSourceProfile> | null>(
    null,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<BrowserPasswordImportFailure | null>(null);
  const [summary, setSummary] = useState<BrowserPasswordImportSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bridge
      .importSources()
      .then((all) => {
        if (cancelled) return;
        // Google Chrome is the supported source.
        const chrome = all.filter((source) => source.sourceId === "chrome");
        setSources(chrome);
        setSelected(chrome[0]?.directory ?? null);
      })
      .catch(() => {
        if (!cancelled) setSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const chosen = sources?.find((source) => source.directory === selected) ?? null;

  const run = async () => {
    if (chosen === null || running) return;
    setRunning(true);
    setFailure(null);
    try {
      const result = await bridge.importFromChrome({
        profileId,
        sourceId: chosen.sourceId,
        sourceProfileDirectory: chosen.directory,
      });
      if (result.kind === "imported") setSummary(result.summary);
      else setFailure(result.reason);
    } catch {
      setFailure("readFailed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import passwords from Chrome</DialogTitle>
          <DialogDescription>
            Into &ldquo;{props.profileName}&rdquo;. Passwords are encrypted on this device.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {summary !== null ? (
            <ul aria-label="Import summary" className="grid gap-1 text-sm">
              {summaryLines(summary).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : sources === null ? (
            <p className="text-sm text-muted-foreground">Looking for Chrome profiles…</p>
          ) : sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Google Chrome profiles were found.</p>
          ) : (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label>Chrome profile</Label>
                <Select
                  value={selected}
                  onValueChange={(value) => {
                    if (typeof value === "string") setSelected(value);
                  }}
                >
                  <SelectTrigger size="sm" aria-label="Chrome profile">
                    <SelectValue>{chosen?.name ?? "Choose a profile"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {sources.map((source) => (
                      <SelectItem key={source.directory} value={source.directory}>
                        {source.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <p className="text-sm text-muted-foreground">
                macOS will ask whether BusyBoy may use &ldquo;Chrome Safe Storage&rdquo; from your
                keychain. That&rsquo;s the key Chrome encrypts its passwords with; choose Allow to
                continue. Passkeys, cards and addresses aren&rsquo;t imported.
              </p>
              {failure !== null ? (
                <p role="alert" className="text-sm text-destructive">
                  {IMPORT_FAILURE_MESSAGES[failure]}
                </p>
              ) : null}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {summary !== null ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="outline" disabled={running} onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={running || chosen === null} onClick={() => void run()}>
                {running ? "Importing…" : failure !== null ? "Retry" : "Import"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

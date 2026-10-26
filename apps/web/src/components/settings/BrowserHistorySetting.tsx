import {
  CHROME_HISTORY_IMPORT_FAILURE_COPY,
  ChromeHistoryImportFailureReason,
} from "@t3tools/contracts";
import { History } from "lucide-react";
import { useState } from "react";

import { clearBrowserHistory } from "~/browserHistoryStore";
import { previewBridge } from "~/components/preview/previewBridge";
import { forgetRecentlySeenUrls } from "~/previewStateStore";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export const chromeHistoryImportFailureCopy = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : String(cause);
  const reason = ChromeHistoryImportFailureReason.literals.find((candidate) =>
    message.includes(`failed: ${candidate}.`),
  );
  return CHROME_HISTORY_IMPORT_FAILURE_COPY[reason ?? "readFailed"];
};

export function BrowserHistorySetting({ disabled }: { readonly disabled: boolean }) {
  const [importing, setImporting] = useState(false);
  const [clearPending, setClearPending] = useState(false);

  // Both the address-bar history in the desktop app and the "Recently used"
  // pages this window keeps per project.
  const clearHistory = () => {
    setClearPending(false);
    if (!previewBridge) {
      return;
    }
    void previewBridge
      .clearBrowsingHistory()
      .then(() => {
        clearBrowserHistory();
        forgetRecentlySeenUrls();
        toastManager.add({ type: "success", title: "Cleared browsing history" });
      })
      .catch(() => toastManager.add({ type: "error", title: "Could not clear browsing history" }));
  };

  const importChromeHistory = () => {
    if (!previewBridge) {
      return;
    }
    setImporting(true);
    void previewBridge
      .importChromeHistory()
      .then(({ imported }) =>
        toastManager.add({
          type: "success",
          title: "Imported Chrome history",
          description: `${imported.toLocaleString()} ${imported === 1 ? "page" : "pages"} from the last six weeks.`,
        }),
      )
      .catch((cause: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not import Chrome history",
          description: chromeHistoryImportFailureCopy(cause),
        }),
      )
      .finally(() => setImporting(false));
  };

  return (
    <SettingsRow
      {...searchableSetting("browser-history")}
      description="Pages you visit in the in-app browser are suggested in its address bar. Import Chrome's recent history to start with the sites you already use."
      control={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || importing}
            onClick={importChromeHistory}
          >
            {importing ? <Spinner className="size-3.5" /> : <History />}
            Import from Chrome
          </Button>
          {/* A clear during an import would race it; wait for the import. */}
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || importing}
            onClick={() => setClearPending(true)}
          >
            Clear history
          </Button>
        </div>
      }
    >
      <AlertDialog open={clearPending} onOpenChange={setClearPending}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear browsing history?</AlertDialogTitle>
            <AlertDialogDescription>
              The address bar stops suggesting pages you visited, and the browser forgets its
              recently used pages. Cookies and saved passwords are not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={clearHistory}>
              Clear history
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsRow>
  );
}

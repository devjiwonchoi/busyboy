import {
  CHROME_HISTORY_IMPORT_FAILURE_COPY,
  ChromeHistoryImportFailureReason,
} from "@t3tools/contracts";
import { History } from "lucide-react";
import { useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";

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
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || importing}
          onClick={importChromeHistory}
        >
          {importing ? <Spinner className="size-3.5" /> : <History />}
          Import from Chrome
        </Button>
      }
    />
  );
}

import { KeyRoundIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { Button } from "~/components/ui/button";

import { useSavedPasswordStatus } from "./savedPasswordStatusStore";

const DISMISSED_STORAGE_KEY = "busyboy.passwordImportOnboarding.dismissed";

const readDismissed = () => {
  try {
    return window.localStorage.getItem(DISMISSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * Offered in the empty browser until the user has any saved password, so the
 * first sign-in an agent attempts can already be filled.
 */
export function PasswordImportOnboardingCard({ onImport }: { readonly onImport: () => void }) {
  const status = useSavedPasswordStatus(previewBridge !== null);
  const [dismissed, setDismissed] = useState(readDismissed);

  if (dismissed || status === null || status.count > 0 || status.chromeSync !== null) {
    return null;
  }

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_STORAGE_KEY, "1");
    } catch {
      // Without storage the card simply returns next time.
    }
  };

  return (
    <div className="flex items-start gap-3 rounded-lg border bg-card p-3 text-left">
      <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <p className="font-medium text-sm">Sign in with your saved passwords</p>
          <p className="text-muted-foreground text-sm">
            Import from Chrome, Apple Passwords or 1Password. Logins fill in automatically, and
            agents never see the passwords.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={onImport}>
            Import passwords
          </Button>
          <Button size="sm" variant="ghost" onClick={dismiss}>
            Not now
          </Button>
        </div>
      </div>
      <Button size="icon-xs" variant="ghost-muted" aria-label="Dismiss" onClick={dismiss}>
        <XIcon />
      </Button>
    </div>
  );
}

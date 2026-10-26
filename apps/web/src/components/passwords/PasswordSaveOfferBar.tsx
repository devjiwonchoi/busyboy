// Adapted from Min (https://github.com/minbrowser/min), js/passwordManager/passwordCapture.js,
// licensed under Apache-2.0. Modified for Busyboy: rewritten as a React component,
// the password itself stays in the desktop main process and is never shown here,
// and the same login with a new password is offered as an update.

import { KeyRoundIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";

import { respondToPasswordSaveOffer, usePasswordSaveOffer } from "./passwordSaveOfferStore";

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** Asks whether to save the login the page in this tab just submitted. */
export function PasswordSaveOfferBar({ tabId }: { readonly tabId: string | null }) {
  const offer = usePasswordSaveOffer(tabId);
  // Keyed by offer so a new sign-in starts from its own username.
  const [edited, setEdited] = useState<{ readonly offerId: string; readonly username: string }>();

  if (offer === null) {
    return null;
  }

  const username = edited?.offerId === offer.offerId ? edited.username : offer.username;
  const site = hostOf(offer.origin);

  const answer = (decision: "save" | "never" | "dismiss") => {
    void respondToPasswordSaveOffer({ offer, decision, username }).catch(() => {
      toastManager.add({ type: "error", title: `Could not save the password for ${site}` });
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-2 text-sm">
      <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 shrink truncate">
        {offer.isUpdate ? "Update the saved password for" : "Save password for"}{" "}
        <span className="font-medium">{site}</span>?
      </span>
      <Input
        size="sm"
        className="w-44"
        value={username}
        placeholder="Username"
        aria-label="Username"
        onChange={(event) => setEdited({ offerId: offer.offerId, username: event.target.value })}
      />
      <div className="ml-auto flex items-center gap-1">
        <Button size="sm" onClick={() => answer("save")}>
          {offer.isUpdate ? "Update" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => answer("never")}>
          Never for this site
        </Button>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Not now"
          onClick={() => answer("dismiss")}
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );
}

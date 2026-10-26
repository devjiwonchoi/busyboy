import type { SavedPasswordStatus } from "@t3tools/contracts";
import { KeyRoundIcon, MoreVertical } from "lucide-react";
import { useState } from "react";

import { PasswordImportDialog } from "~/components/passwords/PasswordImportDialog";
import {
  refreshSavedPasswordStatus,
  useSavedPasswordStatus,
} from "~/components/passwords/savedPasswordStatusStore";
import { previewBridge } from "~/components/preview/previewBridge";

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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export const savedPasswordStatusLabel = (status: SavedPasswordStatus): string => {
  const count = `${status.count.toLocaleString()} saved ${status.count === 1 ? "password" : "passwords"}`;
  return status.chromeSync === null
    ? count
    : `${count} · Syncing from Chrome (${status.chromeSync.profileName})`;
};

export function BrowserPasswordsSetting({ disabled }: { readonly disabled: boolean }) {
  const status = useSavedPasswordStatus(!disabled);
  const [importOpen, setImportOpen] = useState(false);
  const [clearPending, setClearPending] = useState(false);

  const stopChromeSync = () => {
    void previewBridge
      ?.stopChromePasswordSync()
      .then(() => toastManager.add({ type: "success", title: "Stopped syncing from Chrome" }))
      .catch(() => toastManager.add({ type: "error", title: "Could not stop syncing from Chrome" }))
      .finally(() => void refreshSavedPasswordStatus());
  };

  const clearPasswords = () => {
    setClearPending(false);
    void previewBridge
      ?.clearSavedPasswords()
      .then(() => toastManager.add({ type: "success", title: "Removed saved passwords" }))
      .catch(() => toastManager.add({ type: "error", title: "Could not remove saved passwords" }))
      .finally(() => void refreshSavedPasswordStatus());
  };

  return (
    <SettingsRow
      {...searchableSetting("browser-saved-passwords")}
      description="Saved logins fill in automatically in the in-app browser, so agents can sign in without seeing your passwords. Chrome passwords keep syncing after the first import."
      status={status === null || disabled ? null : savedPasswordStatusLabel(status)}
      control={
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setImportOpen(true)}
          >
            <KeyRoundIcon />
            Import passwords
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  disabled={disabled || status === null}
                  aria-label="Saved password options"
                />
              }
            >
              <MoreVertical />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem disabled={status?.chromeSync == null} onClick={stopChromeSync}>
                Stop syncing from Chrome
              </MenuItem>
              <MenuItem
                variant="destructive"
                disabled={(status?.count ?? 0) === 0}
                onClick={() => setClearPending(true)}
              >
                Remove all saved passwords
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      }
    >
      {disabled ? null : <PasswordImportDialog open={importOpen} onOpenChange={setImportOpen} />}
      <AlertDialog open={clearPending} onOpenChange={setClearPending}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove all saved passwords?</AlertDialogTitle>
            <AlertDialogDescription>
              The in-app browser stops filling them and stops syncing from Chrome. Passwords in
              Chrome, 1Password and Apple Passwords are not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={clearPasswords}>
              Remove passwords
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsRow>
  );
}

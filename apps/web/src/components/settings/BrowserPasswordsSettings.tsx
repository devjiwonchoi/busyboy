import type {
  BrowserLoginSummary,
  BrowserPasswordsAddInput,
  DesktopBrowserPasswordsBridge,
} from "@t3tools/contracts";
import { Copy, Eye, EyeOff, Globe, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useBrowserDefaults } from "~/browser/browserDefaults";
import {
  readBrowserPasswordsBridge,
  useBrowserNeverSaveList,
  useBrowserPasswordsList,
  useBrowserPasswordsStatus,
} from "~/browser/browserPasswords";
import { useCachedFaviconForUrl } from "~/browserFaviconStore";
import { FaviconImage } from "~/components/preview/PreviewFaviconIcon";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useDebouncedValue } from "~/state/queries";

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
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  formatLastUsed,
  loginSite,
  passwordsUnavailableMessage,
} from "./BrowserPasswordsSettings.logic";
import { SettingsRow } from "./settingsLayout";
import { ChromePasswordImportDialog } from "./ChromePasswordImportDialog";
import { searchableSetting } from "./settingsSearch";

const SEARCH_DEBOUNCE_MS = 250;
const COPIED_MS = 2000;
const DUPLICATE_USERNAME_MESSAGE =
  "Another saved password for this site already uses that username.";

/** Hidden outside the desktop app, where there is no password vault. */
export function BrowserPasswordsSetting() {
  const bridge = readBrowserPasswordsBridge();
  return bridge ? <BrowserPasswordsPane bridge={bridge} /> : null;
}

function BrowserPasswordsPane({ bridge }: { readonly bridge: DesktopBrowserPasswordsBridge }) {
  const browserDefaults = useBrowserDefaults();
  const persistentProfiles = browserDefaults.profiles.filter(
    (profile) => profile.kind === "persistent",
  );
  const [selectedProfileId, setSelectedProfileId] = useState(browserDefaults.profileId);
  const profileId = persistentProfiles.some((profile) => profile.id === selectedProfileId)
    ? selectedProfileId
    : browserDefaults.profileId;
  const profileName =
    persistentProfiles.find((profile) => profile.id === profileId)?.name ?? "Default";

  const status = useBrowserPasswordsStatus(profileId);
  const available = status?.available === true;
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const logins = useBrowserPasswordsList(profileId, debouncedQuery, available);
  const neverSave = useBrowserNeverSaveList(profileId, available);

  // The summary is kept so a detail stays open when an edit stops it matching the search.
  const [selected, setSelected] = useState<{
    readonly profileId: string;
    readonly login: BrowserLoginSummary;
  } | null>(null);
  const selectedLogin =
    selected !== null && selected.profileId === profileId
      ? (logins?.find((login) => login.id === selected.login.id) ?? selected.login)
      : null;
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  const removeNeverSave = (id: number, origin: string) => {
    void bridge.neverSave.remove({ profileId, ids: [id] }).catch(() => {
      toastManager.add({ type: "error", title: `Could not remove ${loginSite(origin)}` });
    });
  };

  const deleteAll = async () => {
    if (deletingAll) return;
    setDeletingAll(true);
    try {
      const result = await bridge.deleteAll({ profileId });
      if (result.kind === "deleted") {
        toastManager.add({
          type: "success",
          title: result.count === 1 ? "Deleted 1 password" : `Deleted ${result.count} passwords`,
        });
      }
      setDeleteAllOpen(false);
    } catch {
      toastManager.add({ type: "error", title: "Could not delete passwords" });
    }
    setDeletingAll(false);
  };

  const hasNoLogins = logins !== null && logins.length === 0 && debouncedQuery.length === 0;

  return (
    <SettingsRow
      {...searchableSetting("browser-passwords")}
      description="Sign-ins saved from the in-app browser. Encrypted on this device and never synced."
      control={
        available ? (
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            Add password…
          </Button>
        ) : null
      }
    >
      <div className="mt-2 mb-2 flex flex-col gap-2">
        {persistentProfiles.length > 1 ? (
          <Select
            value={profileId}
            onValueChange={(value) => {
              if (typeof value === "string") {
                setSelectedProfileId(value);
                setSelected(null);
              }
            }}
          >
            <SelectTrigger size="sm" className="w-40" aria-label="Passwords profile">
              <SelectValue>{profileName}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {persistentProfiles.map((profile) => (
                <SelectItem hideIndicator key={profile.id} value={profile.id}>
                  {profile.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        {status === null ? (
          <p className="text-xs text-muted-foreground">Loading passwords…</p>
        ) : !status.available ? (
          <p
            role="status"
            className="rounded-lg border border-warning/32 bg-warning/8 px-3 py-2 text-xs text-warning-foreground"
          >
            {passwordsUnavailableMessage(status.reason)}
          </p>
        ) : (
          <>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                nativeInput
                size="sm"
                type="search"
                className="[&_input]:pl-7.5"
                aria-label="Search passwords"
                placeholder="Search by site or username"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </div>
            <div className="overflow-hidden rounded-lg border border-border/60">
              {logins === null ? (
                <p className="px-3 py-3 text-xs text-muted-foreground">Loading passwords…</p>
              ) : logins.length === 0 ? (
                <p className="px-3 py-3 text-xs text-muted-foreground">
                  {debouncedQuery.length > 0
                    ? "No saved passwords match."
                    : "Passwords you save or add show up here."}
                </p>
              ) : (
                <div role="list" aria-label="Saved passwords" className="max-h-96 overflow-y-auto">
                  {logins.map((login) => (
                    <LoginRow
                      key={login.id}
                      login={login}
                      onOpen={() => setSelected({ profileId, login })}
                    />
                  ))}
                </div>
              )}
            </div>
            <section aria-label="Never saved" className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Never saved</h3>
              {neverSave.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Sites where you chose never to save a password show up here.
                </p>
              ) : (
                <div
                  role="list"
                  aria-label="Never saved sites"
                  className="overflow-hidden rounded-lg border border-border/60"
                >
                  {neverSave.map((entry) => (
                    <div
                      key={entry.id}
                      role="listitem"
                      className="flex items-center gap-3 border-b border-border/60 px-3 py-1.5 last:border-b-0"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {loginSite(entry.origin)}
                      </span>
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Remove ${loginSite(entry.origin)} from never saved`}
                        onClick={() => removeNeverSave(entry.id, entry.origin)}
                      >
                        <X />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                Import from Chrome…
              </Button>
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={hasNoLogins}
                onClick={() => setDeleteAllOpen(true)}
              >
                Delete all passwords…
              </Button>
              <p className="text-xs text-muted-foreground">
                Importing or exporting passwords as CSV isn&rsquo;t available.
              </p>
            </div>
          </>
        )}
      </div>
      {available && selectedLogin ? (
        <LoginDetailDialog
          key={`${profileId}\0${selectedLogin.id}`}
          bridge={bridge}
          profileId={profileId}
          login={selectedLogin}
          onClose={() => setSelected(null)}
        />
      ) : null}
      {available && importOpen ? (
        <ChromePasswordImportDialog
          key={profileId}
          bridge={bridge}
          profileId={profileId}
          profileName={profileName}
          onClose={() => setImportOpen(false)}
        />
      ) : null}
      {available && addOpen ? (
        <AddPasswordDialog
          key={profileId}
          bridge={bridge}
          profileId={profileId}
          onClose={() => setAddOpen(false)}
        />
      ) : null}
      <AlertDialog
        open={deleteAllOpen}
        onOpenChange={(open) => {
          if (!open && !deletingAll) setDeleteAllOpen(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all passwords in “{profileName}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Every saved password in this profile is deleted. This can&rsquo;t be undone.
              You&rsquo;ll be asked to confirm it&rsquo;s you.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={deletingAll}
              render={<Button variant="outline" disabled={deletingAll} />}
            >
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={deletingAll} onClick={() => void deleteAll()}>
              {deletingAll ? "Deleting…" : "Delete all"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsRow>
  );
}

function LoginRow(props: { readonly login: BrowserLoginSummary; readonly onOpen: () => void }) {
  const { login } = props;
  const favicon = useCachedFaviconForUrl(login.origin);
  const site = loginSite(login.origin);
  const lastUsed = formatLastUsed(login.lastUsedAt);
  return (
    <div role="listitem" className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        onClick={props.onOpen}
        title={login.origin}
        aria-label={`${site}, ${login.username || "no username"}`}
        className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <FaviconImage
          sources={[favicon]}
          fallback={<Globe aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
          className="size-4 shrink-0 rounded-sm object-contain"
        />
        <span data-slot="site" className="min-w-0 flex-1 truncate text-sm text-foreground">
          {site}
        </span>
        <span
          data-slot="username"
          className="max-w-48 shrink-0 truncate text-xs text-muted-foreground"
        >
          {login.username || "No username"}
        </span>
        <span
          title="Last used"
          className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums"
        >
          {lastUsed}
        </span>
      </button>
    </div>
  );
}

/**
 * A revealed password lives only in this component's state, so it is gone
 * once the dialog closes or the profile changes (both unmount it).
 */
function LoginDetailDialog(props: {
  readonly bridge: DesktopBrowserPasswordsBridge;
  readonly profileId: string;
  readonly login: BrowserLoginSummary;
  readonly onClose: () => void;
}) {
  const { bridge, profileId, login, onClose } = props;
  const id = login.id;
  const site = loginSite(login.origin);

  const [username, setUsername] = useState(login.username);
  // Queued saves compare against the refs; render compares against the state.
  const savedUsernameRef = useRef(login.username);
  const [savedUsername, setSavedUsername] = useState(login.username);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  // `null` means untouched: the field shows the revealed password, or nothing.
  const [passwordDraft, setPasswordDraft] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const savedNoteRef = useRef<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied">("idle");
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const saveChainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const { copyToClipboard, isCopied: usernameCopied } = useCopyToClipboard<void>();

  useEffect(() => {
    let cancelled = false;
    bridge
      .note({ profileId, id })
      .then((result) => {
        if (cancelled) return;
        savedNoteRef.current = result.note;
        setSavedNote(result.note);
        setNote(result.note);
      })
      .catch(() => {
        if (cancelled) return;
        savedNoteRef.current = "";
        setSavedNote("");
        setNote("");
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, id, profileId]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  /** Saves run one at a time so blur and Save never race each other. */
  const queue = (save: () => Promise<boolean>): Promise<boolean> => {
    const next = saveChainRef.current.then(save, save);
    saveChainRef.current = next.catch(() => false);
    return next;
  };

  const saveUsername = () =>
    queue(async () => {
      const next = username;
      if (next === savedUsernameRef.current) return true;
      try {
        const result = await bridge.update({ profileId, id, username: next });
        if (result.kind === "duplicate") {
          setUsernameError(DUPLICATE_USERNAME_MESSAGE);
          return false;
        }
        if (result.kind === "notFound") {
          onClose();
          return false;
        }
        savedUsernameRef.current = next;
        setSavedUsername(next);
        setUsernameError(null);
        return true;
      } catch {
        toastManager.add({ type: "error", title: "Could not save username" });
        return false;
      }
    });

  const savePassword = () =>
    queue(async () => {
      const next = passwordDraft;
      if (next === null || next === revealed) return true;
      if (next === "") {
        setPasswordDraft(null);
        return true;
      }
      try {
        const result = await bridge.update({ profileId, id, password: next });
        if (result.kind === "notFound") {
          onClose();
          return false;
        }
        setPasswordDraft(null);
        setRevealed((current) => (current === null ? null : next));
        toastManager.add({ type: "success", title: "Password updated" });
        return true;
      } catch {
        toastManager.add({ type: "error", title: "Could not save password" });
        return false;
      }
    });

  const saveNote = () =>
    queue(async () => {
      const next = note;
      if (next === null || next === savedNoteRef.current) return true;
      try {
        const result = await bridge.update({ profileId, id, note: next });
        if (result.kind === "notFound") {
          onClose();
          return false;
        }
        savedNoteRef.current = next;
        setSavedNote(next);
        return true;
      } catch {
        toastManager.add({ type: "error", title: "Could not save note" });
        return false;
      }
    });

  const saveAll = async () => {
    const results = await Promise.all([saveUsername(), savePassword(), saveNote()]);
    return results.every(Boolean);
  };

  const toggleReveal = async () => {
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    if (revealing) return;
    setRevealing(true);
    try {
      const result = await bridge.reveal({ profileId, id });
      if (result.kind === "revealed") setRevealed(result.password);
      else if (result.kind === "notFound") onClose();
      // `cancelled`: the user declined the device check; stay masked.
    } catch {
      toastManager.add({ type: "error", title: "Could not show password" });
    }
    setRevealing(false);
  };

  const copyPassword = async () => {
    if (copyState === "copying") return;
    setCopyState("copying");
    try {
      const result = await bridge.copy({ profileId, id });
      if (result.kind === "done") {
        setCopyState("copied");
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopyState("idle"), COPIED_MS);
        return;
      }
      if (result.kind === "notFound") onClose();
    } catch {
      toastManager.add({ type: "error", title: "Could not copy password" });
    }
    setCopyState("idle");
  };

  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await bridge.remove({ profileId, ids: [id] });
      toastManager.add({ type: "success", title: "Password deleted" });
      setConfirmDelete(false);
      onClose();
    } catch {
      toastManager.add({ type: "error", title: "Could not delete password" });
      setDeleting(false);
    }
  };

  const unsavedChanges =
    username !== savedUsername ||
    (passwordDraft !== null && passwordDraft !== "" && passwordDraft !== revealed) ||
    (note !== null && note !== savedNote);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{site}</DialogTitle>
          <DialogDescription>{login.origin}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="browser-password-username">Username</Label>
            <div className="flex items-center gap-1.5">
              <Input
                nativeInput
                id="browser-password-username"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={usernameError !== null || undefined}
                value={username}
                onChange={(event) => {
                  setUsername(event.currentTarget.value);
                  setUsernameError(null);
                }}
                onBlur={() => void saveUsername()}
              />
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label={usernameCopied ? "Username copied" : "Copy username"}
                disabled={username.length === 0}
                onClick={() => copyToClipboard(username)}
              >
                <Copy />
              </Button>
            </div>
            {usernameError ? (
              <p aria-live="polite" className="text-xs text-destructive">
                {usernameError}
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="browser-password-password">Password</Label>
            <div className="flex items-center gap-1.5">
              <Input
                nativeInput
                id="browser-password-password"
                type={revealed !== null ? "text" : "password"}
                autoComplete="new-password"
                spellCheck={false}
                placeholder={revealed === null ? "••••••••" : undefined}
                value={passwordDraft ?? revealed ?? ""}
                onChange={(event) => setPasswordDraft(event.currentTarget.value)}
                onBlur={() => void savePassword()}
              />
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label={revealed !== null ? "Hide password" : "Show password"}
                aria-pressed={revealed !== null}
                disabled={revealing}
                onClick={() => void toggleReveal()}
              >
                {revealed !== null ? <EyeOff /> : <Eye />}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={copyState === "copying"}
                onClick={() => void copyPassword()}
              >
                {copyState === "copied" ? "Copied" : "Copy password"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Type a new password to change it. Copied passwords are cleared from the clipboard
              after 30 seconds.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="browser-password-note">Note</Label>
            <Textarea
              id="browser-password-note"
              rows={3}
              disabled={note === null}
              placeholder={note === null ? "Loading…" : "Optional"}
              value={note ?? ""}
              onChange={(event) => setNote(event.currentTarget.value)}
              onBlur={() => void saveNote()}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Last used {formatLastUsed(login.lastUsedAt).toLowerCase()}
          </p>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="destructive-outline"
            className="sm:me-auto"
            onClick={() => setConfirmDelete(true)}
          >
            Delete…
          </Button>
          <Button variant="outline" disabled={!unsavedChanges} onClick={() => void saveAll()}>
            Save
          </Button>
          <Button
            onClick={() => {
              void saveAll().then((ok) => {
                if (ok) onClose();
              });
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
      <AlertDialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!open && !deleting) setConfirmDelete(false);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the password for {site}?</AlertDialogTitle>
            <AlertDialogDescription>
              {login.username
                ? `The saved sign-in for ${login.username} is deleted.`
                : "This saved sign-in is deleted."}{" "}
              This can&rsquo;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={deleting}
              render={<Button variant="outline" disabled={deleting} />}
            >
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={deleting} onClick={() => void remove()}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Dialog>
  );
}

const ADD_FORM_ID = "browser-password-add-form";

type AddConfirm =
  | { readonly kind: "insecure"; readonly origin: string }
  | { readonly kind: "duplicate" };

function AddPasswordDialog(props: {
  readonly bridge: DesktopBrowserPasswordsBridge;
  readonly profileId: string;
  readonly onClose: () => void;
}) {
  const { bridge, profileId, onClose } = props;
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<AddConfirm | null>(null);
  const [flags, setFlags] = useState<
    Pick<BrowserPasswordsAddInput, "allowInsecure" | "replaceExisting">
  >({});
  const [submitting, setSubmitting] = useState(false);

  const edit = (apply: () => void) => {
    apply();
    setConfirm(null);
    setFlags({});
    setUrlError(null);
  };

  const submit = async (
    nextFlags: Pick<BrowserPasswordsAddInput, "allowInsecure" | "replaceExisting">,
  ) => {
    if (submitting || url.trim() === "" || password === "") return;
    setSubmitting(true);
    setFlags(nextFlags);
    try {
      const result = await bridge.add({
        profileId,
        url: url.trim(),
        username,
        password,
        ...nextFlags,
      });
      switch (result.kind) {
        case "added":
        case "updated":
          toastManager.add({ type: "success", title: "Password saved" });
          onClose();
          break;
        case "insecure":
          setConfirm({ kind: "insecure", origin: result.origin });
          break;
        case "duplicate":
          setConfirm({ kind: "duplicate" });
          break;
        case "invalidUrl":
          setConfirm(null);
          setUrlError("Enter a site address, like https://example.com.");
          break;
      }
    } catch {
      toastManager.add({ type: "error", title: "Could not save password" });
    }
    setSubmitting(false);
  };

  const canSubmit = url.trim() !== "" && password !== "" && !submitting;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add password</DialogTitle>
          <DialogDescription>Saved to this profile and encrypted on this device.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={ADD_FORM_ID}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (confirm === null) void submit({});
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="browser-password-add-url">Site</Label>
              <Input
                nativeInput
                id="browser-password-add-url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://example.com"
                aria-invalid={urlError !== null || undefined}
                value={url}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  edit(() => setUrl(value));
                }}
              />
              {urlError ? (
                <p aria-live="polite" className="text-xs text-destructive">
                  {urlError}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="browser-password-add-username">Username</Label>
              <Input
                nativeInput
                id="browser-password-add-username"
                autoComplete="off"
                spellCheck={false}
                value={username}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  edit(() => setUsername(value));
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="browser-password-add-password">Password</Label>
              <Input
                nativeInput
                id="browser-password-add-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  edit(() => setPassword(value));
                }}
              />
            </div>
            {confirm ? (
              <p
                role="alert"
                className="rounded-lg border border-warning/32 bg-warning/8 px-3 py-2 text-xs text-warning-foreground"
              >
                {confirm.kind === "insecure"
                  ? `${loginSite(confirm.origin)} uses http, which isn't secure: others on the network could see this password when it's sent. Save it anyway?`
                  : `A password for ${username ? username : "this sign-in"} on this site is already saved. Update it?`}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          {confirm === null ? (
            <Button type="submit" form={ADD_FORM_ID} disabled={!canSubmit}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={!canSubmit}
              onClick={() =>
                void submit(
                  confirm.kind === "insecure"
                    ? { ...flags, allowInsecure: true }
                    : { ...flags, replaceExisting: true },
                )
              }
            >
              {confirm.kind === "insecure" ? "Save anyway" : "Update existing"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

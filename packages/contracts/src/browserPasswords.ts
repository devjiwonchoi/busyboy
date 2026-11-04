import * as Schema from "effect/Schema";
import { BrowserProfileId } from "./browserProfile.ts";

export const BROWSER_PASSWORD_MAX_LENGTH = 4096;
export const BROWSER_PASSWORD_USERNAME_MAX_LENGTH = 1024;
export const BROWSER_PASSWORD_NOTE_MAX_LENGTH = 4096;
export const BROWSER_PASSWORD_URL_MAX_LENGTH = 2048;
/** Copied passwords are cleared from the clipboard after this long, if still there. */
export const BROWSER_PASSWORD_CLIPBOARD_CLEAR_MS = 30_000;

export const BrowserLoginSource = Schema.Literals(["saved", "manual", "imported_chrome"]);
export type BrowserLoginSource = typeof BrowserLoginSource.Type;

const Id = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Password = Schema.String.check(Schema.isMaxLength(BROWSER_PASSWORD_MAX_LENGTH));
const Username = Schema.String.check(Schema.isMaxLength(BROWSER_PASSWORD_USERNAME_MAX_LENGTH));
const Note = Schema.String.check(Schema.isMaxLength(BROWSER_PASSWORD_NOTE_MAX_LENGTH));

/** What listing returns. There is deliberately no password field. */
export const BrowserLoginSummary = Schema.Struct({
  id: Id,
  origin: Schema.String,
  signonRealm: Schema.String,
  username: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  lastUsedAt: Schema.NullOr(Schema.Number),
  lastFilledAt: Schema.NullOr(Schema.Number),
  timesUsed: Schema.Int,
  source: BrowserLoginSource,
  hasNote: Schema.Boolean,
});
export type BrowserLoginSummary = typeof BrowserLoginSummary.Type;

export const BrowserNeverSaveEntry = Schema.Struct({
  id: Id,
  origin: Schema.String,
  createdAt: Schema.Number,
});
export type BrowserNeverSaveEntry = typeof BrowserNeverSaveEntry.Type;

export const BrowserPasswordsUnavailableReason = Schema.Literals([
  /** The OS keychain-backed encryption is not available; nothing is stored in plaintext instead. */
  "encryptionUnavailable",
  "databaseUnavailable",
  "incognito",
]);
export type BrowserPasswordsUnavailableReason = typeof BrowserPasswordsUnavailableReason.Type;

export const BrowserPasswordsStatusInput = Schema.Struct({ profileId: BrowserProfileId });
export type BrowserPasswordsStatusInput = typeof BrowserPasswordsStatusInput.Type;

export const BrowserPasswordsStatus = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.optional(BrowserPasswordsUnavailableReason),
  touchIdAvailable: Schema.Boolean,
});
export type BrowserPasswordsStatus = typeof BrowserPasswordsStatus.Type;

export const BrowserPasswordsListInput = Schema.Struct({
  profileId: BrowserProfileId,
  /** Matches origin or username, case-insensitively. */
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});
export type BrowserPasswordsListInput = typeof BrowserPasswordsListInput.Type;

export const BrowserPasswordsAddInput = Schema.Struct({
  profileId: BrowserProfileId,
  /** Any URL on the site; it is reduced to its origin. */
  url: Schema.String.check(Schema.isMaxLength(BROWSER_PASSWORD_URL_MAX_LENGTH)),
  username: Username,
  password: Password.check(Schema.isMinLength(1)),
  note: Schema.optional(Note),
  /** The user confirmed saving for a plain `http://` site that isn't on this machine. */
  allowInsecure: Schema.optional(Schema.Boolean),
  /** The user confirmed replacing the saved login with the same site and username. */
  replaceExisting: Schema.optional(Schema.Boolean),
});
export type BrowserPasswordsAddInput = typeof BrowserPasswordsAddInput.Type;

export const BrowserPasswordsAddResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("added"), id: Id }),
  Schema.Struct({ kind: Schema.Literal("updated"), id: Id }),
  /** Needs `replaceExisting` after the user confirms. */
  Schema.Struct({ kind: Schema.Literal("duplicate"), id: Id }),
  /** Needs `allowInsecure` after the user confirms. */
  Schema.Struct({ kind: Schema.Literal("insecure"), origin: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("invalidUrl") }),
]);
export type BrowserPasswordsAddResult = typeof BrowserPasswordsAddResult.Type;

export const BrowserPasswordsUpdateInput = Schema.Struct({
  profileId: BrowserProfileId,
  id: Id,
  username: Schema.optional(Username),
  password: Schema.optional(Password.check(Schema.isMinLength(1))),
  /** An empty string removes the note. */
  note: Schema.optional(Note),
});
export type BrowserPasswordsUpdateInput = typeof BrowserPasswordsUpdateInput.Type;

export const BrowserPasswordsUpdateResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("updated") }),
  /** Another saved login on the site already uses that username. */
  Schema.Struct({ kind: Schema.Literal("duplicate"), id: Id }),
  Schema.Struct({ kind: Schema.Literal("notFound") }),
]);
export type BrowserPasswordsUpdateResult = typeof BrowserPasswordsUpdateResult.Type;

export const BrowserPasswordsIdsInput = Schema.Struct({
  profileId: BrowserProfileId,
  ids: Schema.Array(Id).check(Schema.isMaxLength(10_000)),
});
export type BrowserPasswordsIdsInput = typeof BrowserPasswordsIdsInput.Type;

export const BrowserPasswordsIdInput = Schema.Struct({
  profileId: BrowserProfileId,
  id: Id,
});
export type BrowserPasswordsIdInput = typeof BrowserPasswordsIdInput.Type;

/** A cancelled or failed device check is not an error; the UI just returns to idle. */
export const BrowserPasswordsRevealResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("revealed"), password: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("cancelled") }),
  Schema.Struct({ kind: Schema.Literal("notFound") }),
]);
export type BrowserPasswordsRevealResult = typeof BrowserPasswordsRevealResult.Type;

export const BrowserPasswordsGatedResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("done") }),
  Schema.Struct({ kind: Schema.Literal("cancelled") }),
  Schema.Struct({ kind: Schema.Literal("notFound") }),
]);
export type BrowserPasswordsGatedResult = typeof BrowserPasswordsGatedResult.Type;

export const BrowserPasswordsNoteResult = Schema.Struct({ note: Schema.String });
export type BrowserPasswordsNoteResult = typeof BrowserPasswordsNoteResult.Type;

export const BrowserPasswordsDeleteAllResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("deleted"), count: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("cancelled") }),
]);
export type BrowserPasswordsDeleteAllResult = typeof BrowserPasswordsDeleteAllResult.Type;

export const BrowserPasswordsProfileInput = Schema.Struct({ profileId: BrowserProfileId });
export type BrowserPasswordsProfileInput = typeof BrowserPasswordsProfileInput.Type;

export const BrowserPasswordsChangedEvent = Schema.Struct({ profileId: BrowserProfileId });
export type BrowserPasswordsChangedEvent = typeof BrowserPasswordsChangedEvent.Type;

/** Where the fill list goes, in CSS pixels relative to the webview's top-left. */
export const BrowserPasswordAnchorRect = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type BrowserPasswordAnchorRect = typeof BrowserPasswordAnchorRect.Type;

export const BrowserPasswordFillRow = Schema.Struct({ loginId: Id, username: Schema.String });
export type BrowserPasswordFillRow = typeof BrowserPasswordFillRow.Type;

/**
 * Main → app renderer. The fill list and the save prompt are drawn by BusyBoy
 * over the webview, never inside the page.
 */
export type BrowserPasswordAutofillEvent =
  | {
      readonly type: "fillList";
      readonly tabId: string;
      readonly requestId: string;
      readonly rect: BrowserPasswordAnchorRect;
      readonly rows: ReadonlyArray<BrowserPasswordFillRow>;
      /** Set when the field's frame is on another origin than the page ("for login.example.net"). */
      readonly frameOrigin: string | null;
      /** -1 when nothing is highlighted. */
      readonly selectedIndex: number;
    }
  | { readonly type: "fillListClosed"; readonly tabId: string }
  | {
      readonly type: "savePrompt";
      readonly tabId: string;
      readonly promptId: string;
      readonly mode: "save" | "update";
      readonly origin: string;
      /** Set when the login form was in a frame on another origin than the page. */
      readonly frameOrigin: string | null;
      readonly username: string;
      /** Folded into the key icon in the address bar; the prompt can be reopened. */
      readonly collapsed: boolean;
    }
  | { readonly type: "savePromptClosed"; readonly tabId: string };

export const BrowserPasswordFillChooseInput = Schema.Struct({
  tabId: Schema.String.check(Schema.isMaxLength(128)),
  requestId: Schema.String.check(Schema.isMaxLength(64)),
  loginId: Id,
});
export type BrowserPasswordFillChooseInput = typeof BrowserPasswordFillChooseInput.Type;

export const BrowserPasswordTabInput = Schema.Struct({
  tabId: Schema.String.check(Schema.isMaxLength(128)),
});
export type BrowserPasswordTabInput = typeof BrowserPasswordTabInput.Type;

export const BrowserPasswordPromptInput = Schema.Struct({
  tabId: Schema.String.check(Schema.isMaxLength(128)),
  promptId: Schema.String.check(Schema.isMaxLength(64)),
});
export type BrowserPasswordPromptInput = typeof BrowserPasswordPromptInput.Type;

export const BrowserPasswordPromptResponse = Schema.Struct({
  tabId: Schema.String.check(Schema.isMaxLength(128)),
  promptId: Schema.String.check(Schema.isMaxLength(64)),
  action: Schema.Literals(["save", "notNow", "never"]),
  /** The username as edited in the prompt. */
  username: Schema.optional(Username),
});
export type BrowserPasswordPromptResponse = typeof BrowserPasswordPromptResponse.Type;

export const BrowserPasswordPeekResult = Schema.Struct({
  /** Null when the prompt is gone. */
  password: Schema.NullOr(Schema.String),
});
export type BrowserPasswordPeekResult = typeof BrowserPasswordPeekResult.Type;

export interface DesktopBrowserPasswordAutofillBridge {
  onEvent: (listener: (event: BrowserPasswordAutofillEvent) => void) => () => void;
  /** The person picked a row in BusyBoy's fill list. Main runs the device check, then fills. */
  choose: (input: BrowserPasswordFillChooseInput) => Promise<void>;
  dismissFillList: (input: BrowserPasswordTabInput) => Promise<void>;
  respondToPrompt: (input: BrowserPasswordPromptResponse) => Promise<void>;
  /** The password the person just typed, for the prompt's peek toggle. No device check. */
  peek: (input: BrowserPasswordPromptInput) => Promise<BrowserPasswordPeekResult>;
  /** Re-expand a collapsed prompt from the address bar key icon. */
  reopenPrompt: (input: BrowserPasswordTabInput) => Promise<void>;
}

/**
 * The settings window's view of the vault. Only `reveal` ever returns a
 * password, after the device check, and only to this trusted UI.
 */
export interface DesktopBrowserPasswordsBridge {
  status: (input: BrowserPasswordsStatusInput) => Promise<BrowserPasswordsStatus>;
  list: (input: BrowserPasswordsListInput) => Promise<ReadonlyArray<BrowserLoginSummary>>;
  add: (input: BrowserPasswordsAddInput) => Promise<BrowserPasswordsAddResult>;
  update: (input: BrowserPasswordsUpdateInput) => Promise<BrowserPasswordsUpdateResult>;
  remove: (input: BrowserPasswordsIdsInput) => Promise<void>;
  note: (input: BrowserPasswordsIdInput) => Promise<BrowserPasswordsNoteResult>;
  reveal: (input: BrowserPasswordsIdInput) => Promise<BrowserPasswordsRevealResult>;
  /** Copies in main and clears the clipboard after 30 s if it still holds the password. */
  copy: (input: BrowserPasswordsIdInput) => Promise<BrowserPasswordsGatedResult>;
  deleteAll: (input: BrowserPasswordsProfileInput) => Promise<BrowserPasswordsDeleteAllResult>;
  neverSave: {
    list: (input: BrowserPasswordsProfileInput) => Promise<ReadonlyArray<BrowserNeverSaveEntry>>;
    remove: (input: BrowserPasswordsIdsInput) => Promise<void>;
  };
  onChanged: (listener: (event: BrowserPasswordsChangedEvent) => void) => () => void;
  autofill: DesktopBrowserPasswordAutofillBridge;
}

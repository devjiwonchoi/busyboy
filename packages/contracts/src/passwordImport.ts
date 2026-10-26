import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PasswordImportSourceId = Schema.Literals(["chrome", "1password", "applePasswords"]);
export type PasswordImportSourceId = typeof PasswordImportSourceId.Type;

/** Sources the user exports to a CSV file and picks in a file dialog. */
export const PasswordFileImportSourceId = Schema.Literals(["1password", "applePasswords"]);
export type PasswordFileImportSourceId = typeof PasswordFileImportSourceId.Type;

export const ChromePasswordUnavailableReason = Schema.Literals([
  "notInstalled",
  "unsupportedPlatform",
]);
export type ChromePasswordUnavailableReason = typeof ChromePasswordUnavailableReason.Type;

export const PasswordImportFailureReason = Schema.Literals([
  ...ChromePasswordUnavailableReason.literals,
  "needsKeychainApproval",
  "keychainItemMissing",
  "keychainUnavailable",
  "unknownSourceProfile",
  "readFailed",
  "invalidFile",
  "encryptionUnavailable",
  "saveFailed",
]);
export type PasswordImportFailureReason = typeof PasswordImportFailureReason.Type;

export const ChromePasswordSourceProfile = Schema.Struct({
  directory: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type ChromePasswordSourceProfile = typeof ChromePasswordSourceProfile.Type;

export const ChromePasswordSource = Schema.Struct({
  profiles: Schema.Array(ChromePasswordSourceProfile),
  unavailable: Schema.optional(ChromePasswordUnavailableReason),
});
export type ChromePasswordSource = typeof ChromePasswordSource.Type;

export const DesktopPreviewImportChromePasswordsInputSchema = Schema.Struct({
  sourceProfileDirectory: TrimmedNonEmptyString,
});

export const DesktopPreviewImportPasswordFileInputSchema = Schema.Struct({
  sourceId: PasswordFileImportSourceId,
});

export const PasswordImportResult = Schema.Struct({
  imported: Schema.Int,
  updated: Schema.Int,
  skipped: Schema.Int,
});
export type PasswordImportResult = typeof PasswordImportResult.Type;

export const PasswordFileImportResult = Schema.Struct({
  ...PasswordImportResult.fields,
  /** The plaintext export was moved to the Trash after a successful import. */
  exportTrashed: Schema.Boolean,
});
export type PasswordFileImportResult = typeof PasswordFileImportResult.Type;

/**
 * A login a page just submitted that is not saved yet. The password stays in
 * the desktop main process; the renderer only learns where and for whom.
 */
export const PasswordSaveOffer = Schema.Struct({
  offerId: TrimmedNonEmptyString,
  /** The preview tab whose page submitted the login. */
  tabId: Schema.String,
  origin: Schema.String,
  username: Schema.String,
  /** A login for this username is saved with a different password. */
  isUpdate: Schema.Boolean,
});
export type PasswordSaveOffer = typeof PasswordSaveOffer.Type;

export const PasswordSaveDecision = Schema.Literals(["save", "never", "dismiss"]);
export type PasswordSaveDecision = typeof PasswordSaveDecision.Type;

export const DesktopPreviewRespondPasswordSaveOfferInputSchema = Schema.Struct({
  offerId: TrimmedNonEmptyString,
  decision: PasswordSaveDecision,
  /** The username to save under, which the user may have corrected. */
  username: Schema.String,
});

export const SavedPasswordStatus = Schema.Struct({
  count: Schema.Int,
  /** Set once passwords were imported from Chrome; they then keep syncing. */
  chromeSync: Schema.NullOr(
    Schema.Struct({
      profileName: Schema.String,
      /** `null` until the first sync since the app started. */
      lastSyncedAt: Schema.NullOr(Schema.Number),
    }),
  ),
});
export type SavedPasswordStatus = typeof SavedPasswordStatus.Type;

export const PASSWORD_IMPORT_FAILURE_COPY: Readonly<Record<PasswordImportFailureReason, string>> = {
  notInstalled: "Chrome has no saved passwords on this machine.",
  unsupportedPlatform: "Importing Chrome passwords isn't possible on this platform.",
  needsKeychainApproval: "Allow Keychain access to read Chrome's passwords, then retry.",
  keychainItemMissing: "No Chrome encryption key in your Keychain — open Chrome once, then retry.",
  keychainUnavailable:
    "The system keyring could not be accessed. Make sure it is running and unlocked, then retry.",
  unknownSourceProfile: "That Chrome profile no longer exists.",
  readFailed: "The password data could not be read.",
  invalidFile: "That file isn't a password export. Choose the CSV file you exported.",
  encryptionUnavailable: "Busyboy can't encrypt passwords on this machine, so nothing was saved.",
  saveFailed: "The passwords were read, but couldn't be saved. Try again.",
};

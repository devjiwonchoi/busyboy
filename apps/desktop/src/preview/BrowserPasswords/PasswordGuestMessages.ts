import * as Schema from "effect/Schema";

import {
  MAX_FIELDS_PER_FORM,
  MAX_FORMS_PER_FRAME,
  MAX_SUBMITTED_VALUE_LENGTH,
  MAX_TOKEN_LENGTH,
} from "./PasswordGuestLimits.ts";

/**
 * Messages between the guest preload and main about login forms. Every guest
 * message is hostile input: main decodes it with these schemas, caps sizes,
 * and rate-limits per frame before using it.
 */

export {
  MAX_FIELDS_PER_FORM,
  MAX_FORMS_PER_FRAME,
  MAX_SUBMITTED_VALUE_LENGTH,
  MAX_TOKEN_LENGTH,
} from "./PasswordGuestLimits.ts";

const Token = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_TOKEN_LENGTH));
const Coordinate = Schema.Number.check(Schema.isFinite());

/** CSS pixels relative to the reporting frame's viewport. */
export const GuestRect = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
  width: Coordinate,
  height: Coordinate,
});
export type GuestRect = typeof GuestRect.Type;

export const LoginFormKind = Schema.Literals(["signIn", "signUp", "changePassword"]);
export type LoginFormKind = typeof LoginFormKind.Type;

export const LoginFieldRole = Schema.Literals([
  "username",
  "currentPassword",
  "newPassword",
  "confirmPassword",
]);
export type LoginFieldRole = typeof LoginFieldRole.Type;

export const GuestLoginField = Schema.Struct({
  token: Token,
  role: LoginFieldRole,
  rect: GuestRect,
});
export type GuestLoginField = typeof GuestLoginField.Type;

export const GuestLoginForm = Schema.Struct({
  token: Token,
  kind: LoginFormKind,
  fields: Schema.Array(GuestLoginField).check(Schema.isMaxLength(MAX_FIELDS_PER_FORM)),
  /** Whether any password field currently holds a value. Never the value itself. */
  passwordFilled: Schema.Boolean,
  /** Name or id hints, for filling the right fields later. */
  usernameFieldName: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  passwordFieldName: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
});
export type GuestLoginForm = typeof GuestLoginForm.Type;

/** The frame's full current set of visible login forms; replaces the previous report. */
export const GuestFormsReport = Schema.Struct({
  forms: Schema.Array(GuestLoginForm).check(Schema.isMaxLength(MAX_FORMS_PER_FRAME)),
  /** Last username-like value typed on this page, for multi-step logins. Only from typing. */
  typedUsername: Schema.optional(
    Schema.String.check(Schema.isMaxLength(MAX_SUBMITTED_VALUE_LENGTH)),
  ),
});
export type GuestFormsReport = typeof GuestFormsReport.Type;

export const GuestFieldFocus = Schema.Struct({
  formToken: Token,
  fieldToken: Token,
  rect: GuestRect,
});
export type GuestFieldFocus = typeof GuestFieldFocus.Type;

/** Keys forwarded from a focused field while BusyBoy's fill list is open (↓ opens it). */
export const GuestFieldKey = Schema.Struct({
  formToken: Token,
  fieldToken: Token,
  key: Schema.Literals(["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"]),
});
export type GuestFieldKey = typeof GuestFieldKey.Type;

const SubmittedValue = Schema.String.check(Schema.isMaxLength(MAX_SUBMITTED_VALUE_LENGTH));

/** Read at submit time from the fields the person typed into. */
export const GuestSubmit = Schema.Struct({
  formToken: Token,
  kind: LoginFormKind,
  username: SubmittedValue,
  /** The current (sign-in) password; empty for sign-up forms. */
  password: SubmittedValue,
  /** The new password on sign-up and change-password forms. */
  newPassword: Schema.optional(SubmittedValue),
});
export type GuestSubmit = typeof GuestSubmit.Type;

/** A frame announces itself to main; its parent reports where the frame sits. */
export const GuestFrameToken = Schema.Struct({ token: Token });
export type GuestFrameToken = typeof GuestFrameToken.Type;

export const GuestChildFrame = Schema.Struct({ childToken: Token, rect: GuestRect });
export type GuestChildFrame = typeof GuestChildFrame.Type;

/** Main → one frame. The preload sets values with pristine setters, then drops them. */
export interface PasswordFillCommand {
  readonly formToken: string;
  readonly username: string;
  readonly password: string;
}

export interface PasswordDropdownState {
  readonly open: boolean;
}

export interface PasswordSubmitFormCommand {
  readonly formToken: string;
}

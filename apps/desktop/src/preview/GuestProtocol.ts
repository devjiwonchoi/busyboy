export const START_PICK_CHANNEL = "preview:start-pick";
export const CANCEL_PICK_CHANNEL = "preview:cancel-pick";
export const ELEMENT_PICKED_CHANNEL = "preview:element-picked";
export const ANNOTATION_CAPTURED_CHANNEL = "preview:annotation-captured";
export const ANNOTATION_THEME_CHANNEL = "preview:annotation-theme";
export const ANNOTATION_SEND_ENABLED_CHANNEL = "preview:annotation-send-enabled";
export const HUMAN_INPUT_CHANNEL = "preview:human-input";
export const MOUSE_NAVIGATE_CHANNEL = "preview:mouse-navigate";
export const RECORDING_CURSOR_CHANNEL = "preview:recording-cursor";
export const RECORDING_POINTER_CHANNEL = "preview:recording-pointer";
export const RECORDING_KEY_CHANNEL = "preview:recording-key";
export const RECORDING_INPUT_CHANNEL = "preview:recording-input";
export const RECORDING_CONTROLLER_CHANNEL = "preview:recording-controller";
export const PASSKEY_CREATE_CHANNEL = "preview:passkey-create";
export const PASSKEY_GET_CHANNEL = "preview:passkey-get";
export const PASSKEY_BRIDGE_ARGUMENT = "--busyboy-preview-passkey-bridge";
// Saved passwords (persistent profiles only). Guest → main carries geometry,
// field roles, opaque tokens, and at submit time the person's own typed values.
export const PASSWORD_BRIDGE_ARGUMENT = "--busyboy-preview-password-bridge";
export const PASSWORD_FORMS_CHANNEL = "preview:password-forms";
export const PASSWORD_FIELD_FOCUS_CHANNEL = "preview:password-field-focus";
export const PASSWORD_FIELD_BLUR_CHANNEL = "preview:password-field-blur";
export const PASSWORD_FIELD_KEY_CHANNEL = "preview:password-field-key";
export const PASSWORD_SUBMIT_CHANNEL = "preview:password-submit";
export const PASSWORD_FRAME_TOKEN_CHANNEL = "preview:password-frame-token";
export const PASSWORD_CHILD_FRAME_CHANNEL = "preview:password-child-frame";
// Main → guest, sent to one frame only.
export const PASSWORD_FILL_CHANNEL = "preview:password-fill";
export const PASSWORD_DROPDOWN_STATE_CHANNEL = "preview:password-dropdown-state";
export const PASSWORD_SUBMIT_FORM_CHANNEL = "preview:password-submit-form";
// The picker's page-world helper is stored on `globalThis` under `Symbol.for(...)` of this key.
export const PREVIEW_ELEMENT_CONTEXT_KEY = "busyboy.preview.elementContext";

/**
 * Size limits shared by the guest preload and main. Kept free of imports: the
 * sandboxed preload cannot load packages such as `effect` at runtime.
 */
export const MAX_FORMS_PER_FRAME = 20;
export const MAX_FIELDS_PER_FORM = 8;
export const MAX_TOKEN_LENGTH = 64;
export const MAX_SUBMITTED_VALUE_LENGTH = 4096;

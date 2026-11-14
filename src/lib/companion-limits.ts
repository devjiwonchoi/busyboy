// Shared by the picture form (client) and server/companions.ts (server).

/**
 * Large enough for an avatar picture. Server actions accept bodies up to 1 MB
 * by default, so this leaves room for the form's own overhead.
 */
export const MAX_IMAGE_BYTES = 900 * 1024
export const MAX_IMAGE_TEXT = '900 KB'

/** Sent by the desktop app to the server's utility process before stopping it. */
export const SHUTDOWN_MESSAGE = 'busyboy:shutdown'

/** Sent back by the server once its shutdown handlers have finished. */
export const SHUTDOWN_DONE_MESSAGE = 'busyboy:shutdown-done'

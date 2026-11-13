/**
 * Packages the server loads at runtime that Next's file tracing cannot capture
 * whole: they load native binaries or files by computed paths. next.config.ts
 * keeps them out of the server bundle, scripts/build-desktop.mts installs them
 * as complete folders into the packaged server, and the build fails unless
 * each one loads from that server folder alone. Add a package here when the
 * server starts using one like it.
 */
export const serverExternalPackages = ['node-pty', '@anthropic-ai/claude-agent-sdk']

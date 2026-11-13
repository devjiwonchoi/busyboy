export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { listenForShutdown } = await import('./server/shutdown')
  listenForShutdown()
}

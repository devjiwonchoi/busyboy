const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100)

/** The server that runs the real Grok adapter against tests/fake-grok/grok.mjs. */
export const fakeGrokPort = port + 2
export const fakeGrokURL = `http://127.0.0.1:${fakeGrokPort}`

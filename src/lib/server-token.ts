/** Cookie that carries the per-launch server token from the desktop window. */
export const SERVER_TOKEN_COOKIE = 'busyboy-token'

/** Header that carries the token for requests made outside the window. */
export const SERVER_TOKEN_HEADER = 'x-busyboy-token'

/** Environment variable that hands the token to the server process. */
export const SERVER_TOKEN_ENV = 'BUSYBOY_TOKEN'

/** Set to `1` by the Playwright journeys so the server runs without a token. */
export const TEST_MODE_ENV = 'BUSYBOY_TEST_MODE'

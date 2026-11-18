// why: The string is compiled in, so a standalone or desktop build shows the version it was built from.
import packageJson from "../../package.json";

export const APP_VERSION = packageJson.version;

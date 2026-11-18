import { app } from "electron";

import { selfCheckOutputPath } from "./self-check";

// A dev run says so wherever the app names itself. The self-check keeps the real name.
export const isDevRun = !app.isPackaged && !selfCheckOutputPath(process.argv);

export const APP_LABEL = isDevRun ? "BusyBoy (dev)" : "BusyBoy";

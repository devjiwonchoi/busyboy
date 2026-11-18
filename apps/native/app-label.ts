import { app } from "electron";

import { selfCheckOutputPath } from "./self-check";

const isSelfCheck = selfCheckOutputPath(process.argv) !== null;

export const isDevRun = !app.isPackaged && !isSelfCheck;

export const APP_LABEL = isDevRun ? "BusyBoy (dev)" : "BusyBoy";

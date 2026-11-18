export const DEV_RUN_ENV = "BUSYBOY_DEV";

export const isDevRun = (env: NodeJS.ProcessEnv) => env[DEV_RUN_ENV] === "1";

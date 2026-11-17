import { createHmac } from "node:crypto";

export const SERVER_TOKEN_COOKIE = "busyboy-token";

export const SERVER_TOKEN_HEADER = "x-busyboy-token";

export const SERVER_TOKEN_ENV = "BUSYBOY_TOKEN";

export const TEST_MODE_ENV = "BUSYBOY_TEST_MODE";

export const MCP_TOKEN_HEADER = "x-busyboy-mcp-token";

export const MCP_PATH = "/api/mcp";

export const ALWAYS_ASK_PATH = "/api/always-ask";

// why: Agents never get the server token, which opens every route.
export function mcpTokenFor(serverToken: string) {
  return createHmac("sha256", serverToken).update("busyboy-mcp-endpoint").digest("hex");
}

export const MCP_TASK_PROJECT_PARAM = "project";

// why: A task agent reads untrusted content, so its token cannot reach every later prompt.
export function taskMcpTokenFor(serverToken: string, project: string) {
  return createHmac("sha256", serverToken).update(`busyboy-mcp-task:${project}`).digest("hex");
}

export const MCP_MANAGER_PARAM = "manager";

export function managerMcpTokenFor(serverToken: string, manager: string) {
  return createHmac("sha256", serverToken).update(`busyboy-mcp-manager:${manager}`).digest("hex");
}

// why: The hook file is readable by a task agent, so this token opens only the always-ask path.
export function alwaysAskTokenFor(serverToken: string) {
  return createHmac("sha256", serverToken).update("busyboy-always-ask").digest("hex");
}

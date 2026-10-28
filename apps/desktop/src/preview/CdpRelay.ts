/**
 * Electron allows one debugger client per webContents, so the relay shares the
 * attach the preview manager already holds.
 */
import { PREVIEW_AGENT_SCRIPT_CDP_METHOD, PREVIEW_SIGN_IN_CDP_METHOD } from "@t3tools/contracts";

export interface CdpRelayTarget {
  readonly send: (
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ) => Promise<unknown>;
  /** The page's own CDP target id; Playwright keys the main frame by it. */
  readonly targetId: () => Promise<string>;
  readonly url: () => string;
  readonly title: () => string;
  readonly userAgent: () => string;
  /**
   * The desktop app and the server it launched share a disk, so the server's
   * Playwright reads the file where it asked for it.
   */
  readonly setDownloadDirectory: (directory: string | null) => void;
  /** Answers the agent's sign-in request with a saved login; never returns secrets. */
  readonly signIn: (params: Record<string, unknown>) => Promise<unknown>;
  /** True while a saved password filled for the agent is still in the page. */
  readonly credentialLocked: () => boolean;
  /** The agent ran its own JavaScript in the current page. */
  readonly noteAgentScript: () => void;
  /** Page commands wait for this, as the page is first checked for a password. */
  readonly ready?: () => Promise<void>;
}

export interface CdpRelayConnection {
  readonly receive: (raw: string) => void;
  readonly event: (method: string, params: unknown, sessionId: string | undefined) => void;
}

interface CdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

const isCommand = (value: unknown): value is CdpCommand =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "number" &&
  typeof (value as { method?: unknown }).method === "string";

const BROWSER_CONTEXT_ID = "t3-preview";
const ANNOUNCE = Symbol("announce");
const PAGE_SESSION_ID = "t3-preview-page";

/**
 * While a saved password is in the page the agent may only leave it: navigate,
 * keep sessions attached, and size the view. Everything that reads the page,
 * runs script in it or drives input (which could reveal the field) is refused.
 */
const ALLOWED_WHILE_CREDENTIAL_LOCKED = new Set([
  "Page.enable",
  "Page.navigate",
  "Page.reload",
  "Page.stopLoading",
  "Page.getFrameTree",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.setLifecycleEventsEnabled",
  "Page.bringToFront",
  "Runtime.enable",
  "Runtime.runIfWaitingForDebugger",
  "Network.enable",
  "Network.disable",
  "Log.enable",
]);

export const CREDENTIAL_LOCKED_MESSAGE =
  "A saved password is in this page, so it cannot be read or driven. Navigate to the signed-in page to continue.";

const isAllowedWhileCredentialLocked = (method: string) =>
  ALLOWED_WHILE_CREDENTIAL_LOCKED.has(method) ||
  method.startsWith("Target.") ||
  method.startsWith("Emulation.");

/**
 * Commands that run the agent's own script in the page: a contextless
 * evaluate, a `javascript:` navigation, or a reload that injects a script.
 */
const runsPageScript = (command: CdpCommand) => {
  // Playwright always names a context; only the agent's own code runs without one.
  if (command.method === "Runtime.evaluate") {
    return command.params?.["contextId"] == null && command.params?.["uniqueContextId"] == null;
  }
  if (command.method === "Page.navigate") {
    const url = command.params?.["url"];
    return typeof url === "string" && /^\s*javascript:/i.test(url);
  }
  return command.method === "Page.reload" && command.params?.["scriptToEvaluateOnLoad"] != null;
};

const ACKNOWLEDGED = new Set([
  "Target.setDiscoverTargets",
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.cancelDownload",
]);

export function createCdpRelayConnection(
  target: CdpRelayTarget,
  write: (message: string) => void,
): CdpRelayConnection {
  const send = (message: Record<string, unknown>) => write(JSON.stringify(message));
  let attached = false;
  /**
   * Sessions this relay invented. Extra page sessions (Playwright's
   * `newCDPSession`) all reach the one real debugger session, so each gets the
   * page's events; other ids are the page's own child sessions, such as iframes.
   */
  const sessions = new Map<string, "browser" | "page">([[PAGE_SESSION_ID, "page"]]);
  let sessionSequence = 0;
  const newSession = (kind: "browser" | "page") => {
    const sessionId = `t3-preview-${kind}-${++sessionSequence}`;
    sessions.set(sessionId, kind);
    return sessionId;
  };
  const targetInfo = async () => ({
    targetId: await target.targetId(),
    type: "page",
    title: target.title(),
    url: target.url(),
    attached: true,
    canAccessOpener: false,
    browserContextId: BROWSER_CONTEXT_ID,
  });

  const browserCommand = async (command: CdpCommand): Promise<unknown> => {
    if (ACKNOWLEDGED.has(command.method)) return {};
    switch (command.method) {
      case "Browser.setDownloadBehavior": {
        const directory = command.params?.["downloadPath"];
        const allowed = command.params?.["behavior"] !== "deny" && typeof directory === "string";
        target.setDownloadDirectory(allowed ? directory : null);
        const { browserContextId: _ignored, ...params } = command.params ?? {};
        return target.send("Browser.setDownloadBehavior", params, undefined);
      }
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: "Electron",
          revision: "",
          userAgent: target.userAgent(),
          jsVersion: "",
        };
      case "Target.getTargetInfo":
        return {
          targetInfo: {
            targetId: "browser",
            type: "browser",
            title: "",
            url: "",
            attached: true,
            canAccessOpener: false,
          },
        };
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      case "Target.getTargets":
        return { targetInfos: [await targetInfo()] };
      case "Target.attachToBrowserTarget":
        return { sessionId: newSession("browser") };
      case "Target.attachToTarget": {
        const targetId = command.params?.["targetId"];
        if (targetId !== (await target.targetId()))
          throw new Error("Only this preview tab's page can be attached.");
        return { sessionId: newSession("page") };
      }
      case "Target.detachFromTarget": {
        const sessionId = command.params?.["sessionId"];
        if (typeof sessionId === "string" && sessionId !== PAGE_SESSION_ID)
          sessions.delete(sessionId);
        return {};
      }
      case "Target.setAutoAttach": {
        if (attached) return {};
        attached = true;
        const info = await targetInfo();
        return {
          [ANNOUNCE]: {
            method: "Target.attachedToTarget",
            params: { sessionId: PAGE_SESSION_ID, targetInfo: info, waitingForDebugger: false },
          },
        };
      }
      default:
        throw new Error(`Not supported for a desktop preview tab: ${command.method}`);
    }
  };

  const pageCommand = (command: CdpCommand): Promise<unknown> =>
    target.ready === undefined
      ? runPageCommand(command)
      : target.ready().then(() => runPageCommand(command));

  const runPageCommand = (command: CdpCommand): Promise<unknown> => {
    const child = sessions.get(command.sessionId!) === "page" ? undefined : command.sessionId;
    if (command.method === PREVIEW_SIGN_IN_CDP_METHOD && child === undefined) {
      return target.signIn(command.params ?? {});
    }
    if (command.method === PREVIEW_AGENT_SCRIPT_CDP_METHOD && child === undefined) {
      target.noteAgentScript();
      return Promise.resolve({});
    }
    const scripted = runsPageScript(command);
    if (
      target.credentialLocked() &&
      (scripted || !isAllowedWhileCredentialLocked(command.method))
    ) {
      return Promise.reject(new Error(CREDENTIAL_LOCKED_MESSAGE));
    }
    if (scripted) {
      // Marked again once it has run: a navigation in between would clear the
      // first mark from the document the script actually ran in.
      target.noteAgentScript();
      const sent = target.send(command.method, command.params ?? {}, child);
      void sent.then(target.noteAgentScript, target.noteAgentScript);
      return sent;
    }
    // The page itself is already running, but its child frames are not:
    // Playwright auto-attaches with waitForDebuggerOnStart, so Chromium pauses
    // every new cross-site iframe and worker until this reaches it. Swallowing
    // it left sign-in checks and captchas, which run in such frames, frozen.
    if (command.method === "Runtime.runIfWaitingForDebugger" && child === undefined) {
      return Promise.resolve({});
    }
    return target.send(command.method, command.params ?? {}, child);
  };

  return {
    receive: (raw) => {
      let command: unknown;
      try {
        command = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isCommand(command)) return;
      const result =
        command.sessionId === undefined || sessions.get(command.sessionId) === "browser"
          ? browserCommand(command)
          : pageCommand(command);
      const route = command.sessionId === undefined ? {} : { sessionId: command.sessionId };
      // Replies leave as commands finish, as Chromium's do, so a slow command
      // such as a screenshot never holds up the ones behind it.
      void result.then(
        (value) => {
          const announce =
            typeof value === "object" && value !== null && ANNOUNCE in value
              ? (value as { [ANNOUNCE]: Record<string, unknown> })[ANNOUNCE]
              : undefined;
          send({ id: command.id, result: announce ? {} : (value ?? {}), ...route });
          if (announce) send(announce);
        },
        (cause: unknown) =>
          send({
            id: command.id,
            error: {
              code: -32000,
              message: cause instanceof Error ? cause.message : String(cause),
            },
            ...route,
          }),
      );
    },
    event: (method, params, sessionId) => {
      if (!attached) return;
      // Download events are the browser's; Playwright listens on its root session.
      if (method.startsWith("Browser.download")) {
        send({ method, params });
        return;
      }
      // Electron reports the page's own events with an empty session id.
      if (sessionId) {
        send({ method, params, sessionId });
        return;
      }
      for (const [id, kind] of sessions)
        if (kind === "page") send({ method, params, sessionId: id });
    },
  };
}

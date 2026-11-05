import * as ComputerUseTools from "../../../computerUse/ComputerUseTools.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ComputerUseToolkit } from "./tools.ts";

/**
 * `reads` adds no caller checks: the capability check must come first, so a
 * stale call gets `computer_use_unavailable` before anything else. The
 * capability is only granted to thread sessions, and every tool but
 * computer_apps also needs the thread's active turn.
 */
const handlers = {
  computer_apps: McpToolAccess.reads(ComputerUseTools.apps),
  computer_snapshot: McpToolAccess.reads(ComputerUseTools.snapshot),
  computer_click: McpToolAccess.reads(ComputerUseTools.click),
  computer_type: McpToolAccess.reads(ComputerUseTools.typeText),
  computer_press: McpToolAccess.reads(ComputerUseTools.press),
  computer_scroll: McpToolAccess.reads(ComputerUseTools.scroll),
  computer_fill: McpToolAccess.reads(ComputerUseTools.fill),
  computer_select: McpToolAccess.reads(ComputerUseTools.select),
  computer_invoke_menu: McpToolAccess.reads(ComputerUseTools.invokeMenu),
} satisfies McpToolAccess.Handlers<typeof ComputerUseToolkit.tools>;

export const layer = McpToolAccess.toLayer(ComputerUseToolkit, handlers);

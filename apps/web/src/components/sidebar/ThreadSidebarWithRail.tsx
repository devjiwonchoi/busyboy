import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import ThreadSidebar from "../Sidebar";
import { useSidebar } from "../ui/sidebar";
import { SidebarChromeHeader } from "./SidebarChrome";
import { WorkspaceRail } from "./WorkspaceRail";

/**
 * The thread sidebar with the view rail under its header: a column beside the
 * thread list on desktop, a tab row above it on phones.
 */
export function ThreadSidebarWithRail() {
  const { isMobile } = useSidebar();
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <div className={cn("flex min-h-0 flex-1", isMobile ? "flex-col" : "flex-row")}>
        <WorkspaceRail />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ThreadSidebar withChromeHeader={false} />
        </div>
      </div>
    </>
  );
}

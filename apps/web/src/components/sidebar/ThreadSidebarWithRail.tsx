import { isElectron } from "~/env";
import ThreadSidebar from "../Sidebar";
import { SidebarChromeHeader } from "./SidebarChrome";

export function ThreadSidebarWithRail() {
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <ThreadSidebar withChromeHeader={false} />
    </>
  );
}

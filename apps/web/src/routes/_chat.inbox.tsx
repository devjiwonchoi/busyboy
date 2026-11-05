import { createFileRoute } from "@tanstack/react-router";

import { WaitingOnYouPage } from "../components/inbox/WaitingOnYouPage";
import { SidebarInset } from "../components/ui/sidebar";

export const Route = createFileRoute("/_chat/inbox")({
  component: InboxRouteView,
});

function InboxRouteView() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WaitingOnYouPage />
    </SidebarInset>
  );
}

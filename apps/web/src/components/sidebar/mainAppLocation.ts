import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/projects/") ||
    pathname === "/usage" ||
    pathname === "/pull-requests"
  );
}

export const ALL_PROJECTS_PATH = "/all-projects";

let mainAppHref: string | null = null;
let chatHref: string | null = null;

export function MainAppLocationTracker() {
  const href = useLocation({
    select: (location) => (isSidebarUtilityPage(location.pathname) ? null : location.href),
  });
  const isAllProjects = useLocation({
    select: (location) => location.pathname === ALL_PROJECTS_PATH,
  });
  useEffect(() => {
    if (href === null) return;
    mainAppHref = href;
    if (!isAllProjects) chatHref = href;
  }, [href, isAllProjects]);
  return null;
}

/** Back to the last chat, task or draft the user had open, from the rail's Chat entry. */
export function useNavigateToChat() {
  const navigate = useNavigate();
  return () => navigate({ href: chatHref ?? "/" });
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: mainAppHref ?? "/" });
}

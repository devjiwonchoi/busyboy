import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useDirectorChat } from "../components/director/useDirectorChat";
import { buildThreadRouteParams } from "../threadRoutes";

function AllProjectsRedirect() {
  const director = useDirectorChat();
  const navigate = useNavigate();
  const threadRef = director?.threadRef;
  useEffect(() => {
    if (threadRef) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
        replace: true,
      });
    }
  }, [navigate, threadRef?.environmentId, threadRef?.threadId]);
  return null;
}

export const Route = createFileRoute("/_chat/all-projects")({ component: AllProjectsRedirect });

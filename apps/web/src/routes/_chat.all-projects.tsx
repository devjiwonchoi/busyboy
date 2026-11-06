import { createFileRoute } from "@tanstack/react-router";

import { AllProjectsPage } from "../components/allProjects/AllProjectsPage";

export const Route = createFileRoute("/_chat/all-projects")({
  component: AllProjectsPage,
});

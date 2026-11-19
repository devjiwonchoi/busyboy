import { createFileRoute } from "@tanstack/react-router";

import { ScheduledTasksSettings } from "../components/settings/ScheduledTasksSettings";
import { validateScheduledTasksSearch } from "../components/settings/scheduledTasksSettings.logic";

function SettingsScheduledTasksRoute() {
  const target = Route.useSearch();
  return <ScheduledTasksSettings {...target} />;
}

export const Route = createFileRoute("/_chat/settings/scheduled-tasks")({
  validateSearch: validateScheduledTasksSearch,
  component: SettingsScheduledTasksRoute,
});

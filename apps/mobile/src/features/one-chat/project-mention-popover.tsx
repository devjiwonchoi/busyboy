import { projectMentionHandle, type ProjectMentionStatus } from "@t3tools/shared/one-chat";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

export function filterMentionProjects(
  projects: ReadonlyArray<ProjectMentionStatus>,
  query: string,
): ProjectMentionStatus[] {
  const needle = query.toLowerCase();
  return projects.filter(
    (project) =>
      project.name.toLowerCase().includes(needle) ||
      projectMentionHandle(project.name).toLowerCase().includes(needle),
  );
}

/** Projects to mention after @, each with how much of its work waits on the user. */
export function ProjectMentionPopover(props: {
  readonly projects: ReadonlyArray<ProjectMentionStatus>;
  readonly query: string;
  readonly onPick: (handle: string) => void;
}) {
  const matches = filterMentionProjects(props.projects, props.query);
  if (matches.length === 0) return null;
  return (
    <View
      testID="project-mention-popover"
      className="mx-3 mb-2 rounded-2xl border border-border bg-card px-3 py-1"
    >
      <ScrollView style={{ maxHeight: 200 }} keyboardShouldPersistTaps="always">
        {matches.map((project) => (
          <Pressable
            key={project.projectId}
            accessibilityRole="button"
            className="flex-row items-center gap-3 py-2"
            onPress={() => props.onPick(projectMentionHandle(project.name))}
          >
            <Text className="flex-1 text-sm">@{projectMentionHandle(project.name)}</Text>
            <Text className="text-xs text-foreground-muted">{project.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

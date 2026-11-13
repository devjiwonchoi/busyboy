import type { GraphNode } from "@t3tools/contracts";
import { nodeEndState } from "@t3tools/shared/one-chat";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { OneChatModal } from "./one-chat-modal";

const CRITERION_STATUS = { pending: "Pending", proven: "Proven", failed: "Failed" } as const;

/** A node's agreed end state: Purpose, Success criteria and checks, Do not, File tree, issues. */
export function NodeEndStateDetails(props: {
  readonly node: GraphNode;
  readonly onClose: () => void;
}) {
  const state = nodeEndState(props.node);
  const section = (title: string, lines: ReadonlyArray<string>, mono = false) =>
    lines.length === 0 ? null : (
      <View testID="detail-section" className="gap-1.5">
        <Text className="font-t3-bold text-sm text-foreground">{title}</Text>
        {lines.map((line, index) => (
          <Text
            key={index}
            selectable
            className={`text-sm text-foreground-secondary ${mono ? "font-mono" : ""}`}
          >
            {line}
          </Text>
        ))}
      </View>
    );
  return (
    <OneChatModal title="Details" onClose={props.onClose} testID="node-end-state-details">
      <Text className="font-t3-bold text-base">{state.title}</Text>
      {section("Purpose", state.purpose ? [state.purpose] : [])}
      {section(
        "Success criteria and checks",
        state.criteria.map(
          (criterion) =>
            `• ${criterion.text}${criterion.how ? ` — ${criterion.how}` : ""} · ${
              CRITERION_STATUS[criterion.status]
            }`,
        ),
      )}
      {section("Do not", state.dont)}
      {section(
        "File tree",
        state.expectedFiles.map((file) => (file.change ? `${file.change} ${file.path}` : file.path)),
        true,
      )}
      {section("Issues", state.issues)}
    </OneChatModal>
  );
}

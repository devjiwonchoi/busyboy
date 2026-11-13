import type { EnvironmentId } from "@t3tools/contracts";
import type { ActionCard } from "@t3tools/shared/one-chat";
import type { ReactNode } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/ui/AppText";
import { OneChatModal } from "./one-chat-modal";
import { useTaskSpec } from "./use-task-spec";

/** Section titles, in the order web shows them. */
export const DETAIL_SECTIONS = [
  "Purpose",
  "Success criteria and checks",
  "Do not",
  "Flow",
  "Mockup",
  "File tree",
  "Rules",
] as const;

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <View testID="detail-section" className="gap-1.5">
      <Text className="font-t3-bold text-sm text-foreground">{props.title}</Text>
      {props.children}
    </View>
  );
}

function Body(props: { readonly children: ReactNode; readonly mono?: boolean }) {
  return (
    <Text
      selectable
      className={`text-sm text-foreground-secondary ${props.mono ? "font-mono" : ""}`}
    >
      {props.children}
    </Text>
  );
}

/** The full card: its question, then the plan sections. Empty sections are left out. */
export function ActionCardDetails(props: {
  readonly card: ActionCard;
  readonly environmentId: EnvironmentId | null;
  readonly onClose: () => void;
}) {
  const { card } = props;
  const spec = useTaskSpec(props.environmentId, card.projectId, card.taskId, true);
  const purpose = spec?.goal.trim() || card.goal?.trim() || "";
  const criteria =
    spec && spec.criteria.length > 0
      ? spec.criteria.map((criterion) =>
          criterion.provenBy ? `${criterion.text} — ${criterion.provenBy}` : criterion.text,
        )
      : card.criteria;
  const checks = [
    ...criteria.map((text) => `• ${text}`),
    ...(card.kind === "result" ? card.details.map((detail) => `${detail.label}: ${detail.text}`) : []),
    ...(card.verification ? [card.verification] : []),
  ];
  const rules = card.kind === "result" ? [] : card.details;
  const nonGoals = spec?.nonGoals.trim() ?? "";
  const flow = spec?.flow.trim() ?? "";
  const prototype = spec?.prototype.trim() ?? "";
  const files = spec?.files ?? [];
  return (
    <OneChatModal title="Details" onClose={props.onClose} testID="action-card-details">
      <View className="gap-1">
        <Text className="text-xs text-foreground-muted">
          {card.projectName} · {card.taskTitle}
        </Text>
        <Text className="font-t3-bold text-base">{card.question}</Text>
        {card.detailParagraphs.map((paragraph, index) => (
          <Body key={index}>{paragraph}</Body>
        ))}
      </View>
      {purpose ? (
        <Section title="Purpose">
          <Body>{purpose}</Body>
        </Section>
      ) : null}
      {checks.length > 0 ? (
        <Section title="Success criteria and checks">
          {checks.map((line, index) => (
            <Body key={index}>{line}</Body>
          ))}
        </Section>
      ) : null}
      {nonGoals ? (
        <Section title="Do not">
          <Body>{nonGoals}</Body>
        </Section>
      ) : null}
      {flow ? (
        <Section title="Flow">
          <View className="rounded-lg bg-muted p-3">
            <Body mono>{flow}</Body>
          </View>
        </Section>
      ) : null}
      {prototype ? (
        <Section title="Mockup">
          <View className="h-80 overflow-hidden rounded-lg border border-border">
            <WebView
              originWhitelist={["*"]}
              source={{ html: prototype }}
              javaScriptEnabled={false}
              style={{ flex: 1 }}
            />
          </View>
        </Section>
      ) : null}
      {files.length > 0 ? (
        <Section title="File tree">
          {files.map((file) => (
            <Body key={file.path} mono>
              {`${file.change === "new" ? "+" : file.change === "deleted" ? "-" : "~"} ${file.path}${
                file.why ? `  ${file.why}` : ""
              }`}
            </Body>
          ))}
        </Section>
      ) : null}
      {rules.length > 0 ? (
        <Section title="Rules">
          {rules.map((detail, index) => (
            <Body key={index}>
              {detail.label}: {detail.text}
            </Body>
          ))}
        </Section>
      ) : null}
    </OneChatModal>
  );
}

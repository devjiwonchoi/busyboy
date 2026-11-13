import { Linking, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";

/** One chat bubble: the user's on the right as plain text, the agent's on the left as markdown. */
export function ChatBubble(props: { readonly role: "user" | "assistant"; readonly text: string }) {
  const markdownStyles = useMarkdownPreviewStyles();
  if (props.role === "user") {
    return (
      <View testID="user-bubble" className="mx-4 my-1 max-w-[80%] self-end rounded-2xl bg-primary px-3 py-2">
        <Text selectable className="text-sm text-primary-foreground">
          {props.text}
        </Text>
      </View>
    );
  }
  return (
    <View testID="assistant-bubble" className="mx-4 my-1 max-w-[85%] self-start rounded-2xl bg-muted px-3 py-2">
      <SelectableMarkdownText
        markdown={props.text}
        textStyle={markdownStyles.nativeTextStyle}
        onLinkPress={(href) => void Linking.openURL(href)}
      />
    </View>
  );
}

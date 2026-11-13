import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { WorkspaceRootScreen } from "../workspace/WorkspaceRootScreen";
import { OneChatScreen } from "./one-chat-screen";

/** Home: the one chat screen when the setting is on, otherwise the classic home unchanged. */
export function HomeOrOneChat() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const enabled =
    AsyncResult.isSuccess(preferences) && preferences.value.oneChatScreenEnabled === true;
  return enabled ? <OneChatScreen /> : <WorkspaceRootScreen />;
}

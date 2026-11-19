import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { UsageRouteScreen } from "../../usage/UsageRouteScreen";
import { type NavigationTab } from "./navigation-tab-order";

export function WorkspaceExtraTab(_props: { tab: Extract<NavigationTab, "usage"> }) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      <UsageRouteScreen workspace />
    </>
  );
}

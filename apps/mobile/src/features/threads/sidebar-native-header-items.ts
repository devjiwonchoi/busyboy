import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
} from "@react-navigation/native-stack";

import type { HomeListFilterMenu } from "../home/home-list-filter-menu";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

type NativeHeaderMenuItems = NativeStackHeaderItemMenu["menu"]["items"];
type NativeHeaderIcon = NonNullable<Extract<NativeStackHeaderItem, { type: "button" }>["icon"]>;

function sfSymbolIcon(name: string): NativeHeaderIcon {
  return { type: "sfSymbol", name: name as never };
}

function toNativeHeaderMenuItems(items: HomeListFilterMenu["items"]): NativeHeaderMenuItems {
  return items.map((item) =>
    item.type === "action"
      ? {
          type: "action" as const,
          label: item.title,
          description: item.subtitle,
          onPress: item.onPress,
          state: item.state === "on" ? ("on" as const) : undefined,
        }
      : {
          type: "submenu" as const,
          label: item.title,
          items: toNativeHeaderMenuItems(item.items),
        },
  );
}

/** The home ellipsis menu: the goal map and settings. */
export function homeMenuItems(
  onOpenGoalMap: () => void,
  onOpenSettings: () => void,
): NativeHeaderMenuItems {
  return [
    { type: "action", label: "전체 프로젝트", onPress: onOpenGoalMap },
    { type: "action", label: "설정", onPress: onOpenSettings },
  ];
}

export function createSidebarHeaderItems(input: {
  readonly filterIcon: string;
  readonly filterMenu: HomeListFilterMenu;
  readonly onOpenSettings: () => void;
  /** When set, settings moves into a menu that also opens the goal map. */
  readonly onOpenGoalMap?: () => void;
}): NativeStackHeaderItem[] {
  return [
    withNativeGlassHeaderItem({
      type: "menu",
      axisBehavior: "horizontalOnly",
      label: "",
      accessibilityLabel: "Filter threads",
      icon: sfSymbolIcon(input.filterIcon),
      menu: {
        title: input.filterMenu.title,
        items: toNativeHeaderMenuItems(input.filterMenu.items),
      },
    }),
    input.onOpenGoalMap === undefined
      ? withNativeGlassHeaderItem({
          type: "button",
          axisBehavior: "horizontalOnly",
          label: "Settings",
          accessibilityLabel: "Open settings",
          icon: sfSymbolIcon("gearshape"),
          onPress: input.onOpenSettings,
        })
      : withNativeGlassHeaderItem({
          type: "menu",
          axisBehavior: "horizontalOnly",
          label: "",
          accessibilityLabel: "메뉴",
          icon: sfSymbolIcon("ellipsis"),
          menu: { items: homeMenuItems(input.onOpenGoalMap, input.onOpenSettings) },
        }),
  ];
}

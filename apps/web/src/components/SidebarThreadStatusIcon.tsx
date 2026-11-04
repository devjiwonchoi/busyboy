import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import type { SidebarTopStatusIcon } from "./Sidebar.logic";

const ICONS = {
  working: CircleDashedIcon,
  waiting: CircleDotDashedIcon,
  input: MessageCircleQuestionIcon,
  approval: ShieldQuestionIcon,
  failed: CircleAlertIcon,
  done: CircleCheckIcon,
} as const satisfies Record<SidebarTopStatusIcon, unknown>;

export function SidebarThreadStatusIcon(props: { icon: SidebarTopStatusIcon; className?: string }) {
  const Icon = ICONS[props.icon];
  return <Icon aria-hidden className={cn("size-4 shrink-0", props.className)} />;
}

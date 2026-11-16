import React, { type ReactNode, type ComponentProps } from "react";
import { Panel, type NodeProps, type PanelPosition } from "@xyflow/react";

import { BaseNode } from "@/components/base-node";
import { cn } from "@/lib/utils";

/* GROUP NODE Label ------------------------------------------------------- */

export type GroupNodeLabelProps = ComponentProps<"div">;

export function GroupNodeLabel({
  children,
  className,
  ...props
}: GroupNodeLabelProps) {
  return (
    <div className="h-full w-full" {...props}>
      <div
        className={cn(
          "text-card-foreground bg-secondary w-fit p-2 text-xs",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export type GroupNodeProps = Partial<NodeProps> & {
  label?: ReactNode;
  position?: PanelPosition;
};

/* GROUP NODE -------------------------------------------------------------- */

export function GroupNode({ label, position, ...props }: GroupNodeProps) {
  const getLabelClassName = (position?: PanelPosition) => {
    switch (position) {
      case "top-left":
        return "rounded-br-sm";
      case "top-center":
        return "rounded-b-sm";
      case "top-right":
        return "rounded-bl-sm";
      case "bottom-left":
        return "rounded-tr-sm";
      case "bottom-right":
        return "rounded-tl-sm";
      case "bottom-center":
        return "rounded-t-sm";
      default:
        return "rounded-br-sm";
    }
  };

  return (
    <BaseNode
      // Edited: the registry's `bg-white bg-opacity-50` is Tailwind v3 syntax (no
      // effect in v4) and stays white in dark mode; the card token follows the theme.
      className="h-full overflow-hidden rounded-sm bg-card/50"
      {...props}
    >
      <Panel className="m-0 p-0" position={position}>
        {label && (
          <GroupNodeLabel className={getLabelClassName(position)}>
            {label}
          </GroupNodeLabel>
        )}
      </Panel>
    </BaseNode>
  );
}

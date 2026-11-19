import { cva, type VariantProps } from "class-variance-authority";
import { useGT } from "gt-react";
import { LoaderCircleIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";

// No default size: inside a Button the parent's svg rule sizes the glyph.
const spinnerVariants = cva("motion-safe:visible-animate-spin", {
  variants: {
    size: {
      xs: "size-3",
      sm: "size-3.5",
      md: "size-4",
      lg: "size-5",
    },
    tone: {
      current: "",
      muted: "text-muted-foreground",
    },
  },
  defaultVariants: { tone: "current" },
});

function Spinner({
  className,
  size,
  tone,
  ...props
}: React.ComponentPropsWithoutRef<typeof LoaderCircleIcon> & VariantProps<typeof spinnerVariants>) {
  const gt = useGT();
  return (
    <LoaderCircleIcon
      aria-label={gt("Loading")}
      ref={observeVisibleAnimation}
      className={cn(spinnerVariants({ size, tone }), className)}
      role="status"
      {...props}
    />
  );
}

export { Spinner };

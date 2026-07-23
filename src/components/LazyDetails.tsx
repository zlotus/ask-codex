import { useState, type ComponentPropsWithoutRef, type ReactNode } from "react";

interface LazyDetailsProps extends Omit<ComponentPropsWithoutRef<"details">, "children" | "open" | "onToggle"> {
  children: ReactNode;
  initiallyOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  summary: ReactNode;
  summaryClassName?: string;
}

export function LazyDetails({
  children,
  initiallyOpen = false,
  onOpenChange,
  open: controlledOpen,
  summary,
  summaryClassName,
  ...detailsProps
}: LazyDetailsProps) {
  const [internalOpen, setInternalOpen] = useState(initiallyOpen);
  const open = controlledOpen ?? internalOpen;

  return (
    <details
      {...detailsProps}
      open={open}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        if (controlledOpen === undefined) setInternalOpen(nextOpen);
        onOpenChange?.(nextOpen);
      }}
    >
      <summary className={summaryClassName}>{summary}</summary>
      {open ? children : null}
    </details>
  );
}

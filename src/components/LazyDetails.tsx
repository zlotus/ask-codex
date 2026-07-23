import { useState, type ComponentPropsWithoutRef, type ReactNode } from "react";

interface LazyDetailsProps extends Omit<ComponentPropsWithoutRef<"details">, "children" | "open"> {
  children: ReactNode;
  initiallyOpen?: boolean;
  summary: ReactNode;
  summaryClassName?: string;
}

export function LazyDetails({
  children,
  initiallyOpen = false,
  summary,
  summaryClassName,
  ...detailsProps
}: LazyDetailsProps) {
  const [open, setOpen] = useState(initiallyOpen);

  return (
    <details
      {...detailsProps}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className={summaryClassName}>{summary}</summary>
      {open ? children : null}
    </details>
  );
}

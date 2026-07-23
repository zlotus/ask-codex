import { Check, CircleAlert, LoaderCircle, Minus, X } from "lucide-react";

interface StatusPillProps {
  status?: string;
}

export function StatusPill({ status = "completed" }: StatusPillProps) {
  const normalized = status.toLowerCase();
  const isRunning = normalized.includes("progress") || normalized.includes("running") || normalized === "started";
  const isFailed = normalized.includes("fail") || normalized.includes("error") || normalized === "declined";
  const isStopped = normalized.includes("interrupt") || normalized.includes("cancel");
  const Icon = isRunning ? LoaderCircle : isFailed ? CircleAlert : isStopped ? X : normalized === "pending" ? Minus : Check;
  const tone = isRunning ? "running" : isFailed ? "failed" : isStopped ? "stopped" : "done";
  const label = status.replace(/([a-z])([A-Z])/g, "$1 $2");
  return (
    <span className={`status-pill status-pill--${tone}`}>
      <Icon size={12} className={isRunning ? "spin" : undefined} aria-hidden="true" />
      {label}
    </span>
  );
}

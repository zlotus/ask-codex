import { LoaderCircle } from "lucide-react";
import type { CodexTurn } from "../types/protocol";
import { formatTimestamp, timestampMilliseconds } from "../utils/protocol";
import { StatusPill } from "./StatusPill";

interface TurnStatusSlotProps {
  reasoningActive: boolean;
  turn: CodexTurn;
}

const secondsFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function formatDuration(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${secondsFormatter.format(value / 1_000)}s`;
  const totalSeconds = Math.round(value / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    ...(hours > 0 ? [`${hours}h`] : []),
    ...(minutes > 0 ? [`${minutes}m`] : []),
    ...(seconds > 0 || (hours === 0 && minutes === 0) ? [`${seconds}s`] : []),
  ].join(" ");
}

export function TurnStatusSlot({ reasoningActive, turn }: TurnStatusSlotProps) {
  const inProgress = turn.status === "inProgress";
  const startedAtMs = timestampMilliseconds(turn.startedAt);
  const startedAt = startedAtMs === null ? "" : formatTimestamp(startedAtMs);
  const duration = formatDuration(turn.durationMs);
  const completedStatus = turn.status && !inProgress ? turn.status : undefined;
  const hasMetadata = Boolean(startedAt || duration);

  if (!inProgress && !hasMetadata && !completedStatus) return null;

  return (
    <div
      aria-atomic="true"
      aria-label="Turn status"
      className={`turn-footer turn-status-slot${inProgress ? " turn-status-slot--in-progress" : ""}`}
      role="status"
    >
      {inProgress ? (
        <div
          className={`turn-reasoning-status${reasoningActive ? " turn-reasoning-status--active" : ""}`}
        >
          <LoaderCircle
            aria-hidden="true"
            className={reasoningActive ? "spin" : undefined}
            size={14}
          />
          <span>{reasoningActive ? "Reasoning active" : "Reasoning idle"}</span>
        </div>
      ) : hasMetadata ? (
        <div className="turn-meta" role="group" aria-label="Turn details">
          {startedAt && startedAtMs !== null && (
            <time className="turn-meta__item" dateTime={new Date(startedAtMs).toISOString()}>
              Started {startedAt}
            </time>
          )}
          {duration && <span className="turn-meta__item">Duration {duration}</span>}
        </div>
      ) : null}
      {completedStatus && <StatusPill status={completedStatus} />}
    </div>
  );
}

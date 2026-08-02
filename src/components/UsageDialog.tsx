import { Gauge, RefreshCw, X } from "lucide-react";
import type {
  AccountRateLimitsSnapshot,
  AccountUsageSnapshot,
  RateLimitSnapshot,
  RateLimitWindow,
  ThreadTokenUsage,
} from "../types/protocol";

interface UsageDialogProps {
  open: boolean;
  loading: boolean;
  threadUsage: ThreadTokenUsage | null;
  accountUsage: AccountUsageSnapshot | null;
  rateLimits: AccountRateLimitsSnapshot | null;
  error: string | null;
  onRefresh: () => void;
  onClose: () => void;
}

function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Unavailable";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "Unavailable";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function resetLabel(timestamp: number | null): string {
  if (timestamp === null) return "Reset time unavailable";
  const date = new Date(timestamp * 1_000);
  if (Number.isNaN(date.getTime())) return "Reset time unavailable";
  return `Resets ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)}`;
}

function windowLabel(window: RateLimitWindow, fallback: string): string {
  if (window.windowDurationMins === null) return fallback;
  const label = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (window.windowDurationMins < 60) return label(window.windowDurationMins, "minute");
  if (window.windowDurationMins % 1_440 === 0) return label(window.windowDurationMins / 1_440, "day");
  if (window.windowDurationMins % 60 === 0) return label(window.windowDurationMins / 60, "hour");
  return fallback;
}

function RateWindow({ window, fallback }: { window: RateLimitWindow; fallback: string }) {
  const used = Math.max(0, Math.min(100, window.usedPercent));
  return (
    <div className="usage-limit-window">
      <div>
        <strong>{windowLabel(window, fallback)}</strong>
        <span>{used.toFixed(0)}% used</span>
      </div>
      <progress aria-label={`${windowLabel(window, fallback)} limit used`} max="100" value={used} />
      <span>{resetLabel(window.resetsAt)}</span>
    </div>
  );
}

function rateLimitBuckets(value: AccountRateLimitsSnapshot | null): RateLimitSnapshot[] {
  if (!value) return [];
  const byId = value.rateLimitsByLimitId ? Object.values(value.rateLimitsByLimitId) : [];
  if (byId.length > 0) return byId;
  return value.rateLimits ? [value.rateLimits] : [];
}

function RateLimitRow({ snapshot, index }: { snapshot: RateLimitSnapshot; index: number }) {
  const label = snapshot.limitName || snapshot.limitId || `Limit ${index + 1}`;
  const reached = Boolean(snapshot.rateLimitReachedType || snapshot.spendControlReached);
  return (
    <div className={`usage-limit${reached ? " usage-limit--reached" : ""}`}>
      <div className="usage-limit-heading">
        <strong>{label}</strong>
        {snapshot.planType && <span>{snapshot.planType}</span>}
        {reached && (
          <span className="usage-limit-alert">
            {snapshot.spendControlReached ? "Spend limit reached" : "Limit reached"}
          </span>
        )}
      </div>
      {snapshot.primary && <RateWindow window={snapshot.primary} fallback="Primary window" />}
      {snapshot.secondary && <RateWindow window={snapshot.secondary} fallback="Secondary window" />}
      {snapshot.credits && (
        <p className="usage-credit-line">
          {snapshot.credits.unlimited
            ? "Credits are unlimited"
            : snapshot.credits.hasCredits
              ? `Credit balance ${snapshot.credits.balance ?? "available"}`
              : "No additional credits"}
        </p>
      )}
    </div>
  );
}

export function UsageDialog({
  open,
  loading,
  threadUsage,
  accountUsage,
  rateLimits,
  error,
  onRefresh,
  onClose,
}: UsageDialogProps) {
  if (!open) return null;
  const contextUsed = threadUsage?.modelContextWindow
    ? Math.min(100, (threadUsage.last.totalTokens / threadUsage.modelContextWindow) * 100)
    : null;
  const buckets = rateLimitBuckets(rateLimits);
  const daily = accountUsage?.dailyUsageBuckets?.slice(-7) ?? [];
  const maximumDaily = Math.max(1, ...daily.map((entry) => entry.tokens));

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="usage-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="usage-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <div className="dialog-heading usage-dialog-heading">
          <Gauge size={19} aria-hidden="true" />
          <div>
            <strong id="usage-dialog-title">Usage and limits</strong>
            <span>Read-only Codex service data</span>
          </div>
          <div className="usage-dialog-actions">
            <button
              className="icon-button"
              type="button"
              title="Refresh usage"
              aria-label="Refresh usage"
              onClick={onRefresh}
              disabled={loading}
            >
              <RefreshCw className={loading ? "spin" : undefined} size={16} aria-hidden="true" />
            </button>
            <button className="icon-button" type="button" title="Close" aria-label="Close" autoFocus onClick={onClose}>
              <X size={17} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="usage-dialog-scroll">
          {loading && !threadUsage && !accountUsage && !rateLimits && (
            <p className="usage-dialog-state" role="status">Loading usage</p>
          )}
          {error && <p className="usage-dialog-state usage-dialog-state--error" role="status">{error}</p>}

          <section className="usage-section" aria-labelledby="usage-thread-title">
            <h2 id="usage-thread-title">Current thread</h2>
            {threadUsage ? (
              <>
                {contextUsed !== null && (
                  <div className="usage-context">
                    <div><strong>Latest context</strong><span>{contextUsed.toFixed(0)}%</span></div>
                    <progress aria-label="Latest context window used" max="100" value={contextUsed} />
                    <span>{formatCount(threadUsage.last.totalTokens)} of {formatCount(threadUsage.modelContextWindow)} tokens</span>
                  </div>
                )}
                <dl className="usage-metrics">
                  <div><dt>Thread total</dt><dd>{formatCount(threadUsage.total.totalTokens)}</dd></div>
                  <div><dt>Latest input</dt><dd>{formatCount(threadUsage.last.inputTokens)}</dd></div>
                  <div><dt>Cached input</dt><dd>{formatCount(threadUsage.last.cachedInputTokens)}</dd></div>
                  <div><dt>Latest output</dt><dd>{formatCount(threadUsage.last.outputTokens)}</dd></div>
                  <div><dt>Reasoning</dt><dd>{formatCount(threadUsage.last.reasoningOutputTokens)}</dd></div>
                </dl>
              </>
            ) : (
              <p className="usage-section-empty">Token usage will appear after Codex reports it for this thread.</p>
            )}
          </section>

          <section className="usage-section" aria-labelledby="usage-limits-title">
            <h2 id="usage-limits-title">Rate limits</h2>
            {buckets.length > 0
              ? buckets.map((snapshot, index) => (
                  <RateLimitRow snapshot={snapshot} index={index} key={snapshot.limitId ?? index} />
                ))
              : <p className="usage-section-empty">Rate limits are unavailable for this sign-in.</p>}
          </section>

          <section className="usage-section" aria-labelledby="usage-account-title">
            <h2 id="usage-account-title">Account activity</h2>
            {accountUsage ? (
              <>
                <dl className="usage-metrics usage-metrics--account">
                  <div><dt>Lifetime tokens</dt><dd>{formatCount(accountUsage.summary.lifetimeTokens)}</dd></div>
                  <div><dt>Peak day</dt><dd>{formatCount(accountUsage.summary.peakDailyTokens)}</dd></div>
                  <div><dt>Longest turn</dt><dd>{formatDuration(accountUsage.summary.longestRunningTurnSec)}</dd></div>
                  <div><dt>Current streak</dt><dd>{accountUsage.summary.currentStreakDays === null ? "Unavailable" : `${accountUsage.summary.currentStreakDays}d`}</dd></div>
                </dl>
                {daily.length > 0 && (
                  <div className="usage-daily" aria-label="Recent daily token activity">
                    {daily.map((entry) => (
                      <div className="usage-daily-row" key={entry.startDate}>
                        <time dateTime={entry.startDate}>{entry.startDate}</time>
                        <span><i style={{ width: `${Math.max(2, (entry.tokens / maximumDaily) * 100)}%` }} /></span>
                        <strong>{formatCount(entry.tokens)}</strong>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="usage-section-empty">Account activity is unavailable for this sign-in.</p>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}

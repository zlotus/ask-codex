import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsageDialog } from "./UsageDialog";

const breakdown = {
  totalTokens: 10_000,
  inputTokens: 7_000,
  cachedInputTokens: 2_000,
  cacheWriteInputTokens: 0,
  outputTokens: 3_000,
  reasoningOutputTokens: 1_000,
};

describe("UsageDialog", () => {
  it("renders thread context, account activity, and rate windows", () => {
    render(
      <UsageDialog
        open
        loading={false}
        threadUsage={{ total: breakdown, last: breakdown, modelContextWindow: 20_000 }}
        accountUsage={{
          summary: {
            lifetimeTokens: 1_200_000,
            peakDailyTokens: 50_000,
            longestRunningTurnSec: 90,
            currentStreakDays: 4,
            longestStreakDays: 9,
          },
          dailyUsageBuckets: [{ startDate: "2026-08-01", tokens: 10_000 }],
        }}
        rateLimits={{
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: null,
            credits: null,
            spendControlReached: false,
            planType: "plus",
            rateLimitReachedType: null,
          },
          rateLimitsByLimitId: null,
        }}
        error={null}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Usage and limits" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Latest context window used" })).toHaveValue(50);
    expect(screen.getByRole("progressbar", { name: "5 hours limit used" })).toHaveValue(42);
    expect(screen.getByText("1.2M")).toBeInTheDocument();
    expect(screen.getByText("2026-08-01")).toBeInTheDocument();
  });

  it("refreshes and closes without exposing write actions", () => {
    const onRefresh = vi.fn();
    const onClose = vi.fn();
    render(
      <UsageDialog
        open
        loading={false}
        threadUsage={null}
        accountUsage={null}
        rateLimits={null}
        error="Usage data could not be loaded"
        onRefresh={onRefresh}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh usage" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByText(/reset credit/i)).not.toBeInTheDocument();
  });

  it("surfaces a reached spend control without a generic rate-limit type", () => {
    render(
      <UsageDialog
        open
        loading={false}
        threadUsage={null}
        accountUsage={null}
        rateLimits={{
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: null,
            secondary: null,
            credits: null,
            spendControlReached: true,
            planType: null,
            rateLimitReachedType: null,
          },
          rateLimitsByLimitId: null,
        }}
        error={null}
        onRefresh={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Spend limit reached")).toBeInTheDocument();
  });
});

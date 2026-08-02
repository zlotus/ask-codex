export type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

export interface BootstrapInfo {
  ready: boolean;
  defaultCwd: string;
  authRequired: boolean;
  codexVersion?: string;
}

export interface RpcMessage {
  type: "rpc";
  id: string;
  method: string;
  params: unknown;
}

export interface ResponseMessage {
  type: "response";
  id: string | number;
  result?: unknown;
  error?: unknown;
}

export interface StatusMessage {
  type: "status";
  status: "starting" | "ready" | "error";
  defaultCwd: string;
  version?: string;
  error?: { message: string };
}

export interface RpcResultMessage {
  type: "rpcResult";
  id: string;
  result: unknown;
}

export interface RpcErrorMessage {
  type: "rpcError";
  id: string;
  error: unknown;
}

export interface NotificationMessage {
  type: "notification";
  method: string;
  params: unknown;
}

export interface ServerRequestMessage {
  type: "request";
  id: string | number;
  method: string;
  params: unknown;
}

export type ServerMessage =
  | StatusMessage
  | RpcResultMessage
  | RpcErrorMessage
  | NotificationMessage
  | ServerRequestMessage;

export type ClientMessage = RpcMessage | ResponseMessage;

export type TurnStatus = "inProgress" | "completed" | "failed" | "interrupted" | string;
export type ItemStatus = "inProgress" | "completed" | "failed" | "declined" | string;
export type ImageDetail = "auto" | "low" | "high" | "original";
export type InputModality = "text" | "image" | "audio";

export interface TextUserInput {
  type: "text";
  text: string;
  text_elements: unknown[];
}

export interface LocalImageUserInput {
  type: "localImage";
  path: string;
  detail?: ImageDetail;
}

export interface UrlImageUserInput {
  type: "image";
  url: string;
  detail?: ImageDetail;
}

export type UserInput = TextUserInput | LocalImageUserInput | UrlImageUserInput;

export interface CodexItem {
  id: string;
  type: string;
  status?: ItemStatus;
  approvalReasons?: string[];
  streamOmittedCharacters?: Record<string, number>;
  [key: string]: unknown;
}

export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "completed" | string;
}

export interface TurnPlan {
  explanation?: string;
  plan: PlanStep[];
}

export interface CodexTurn {
  id: string;
  status?: TurnStatus;
  items: CodexItem[];
  error?: unknown;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  diff?: string;
  plan?: TurnPlan;
  recoveryOmissions?: string[];
  historyDetail?: {
    cursor: string | null;
    nextItemCursor?: string;
    status: "idle" | "loading" | "error" | "unavailable";
    error: string | null;
  };
  [key: string]: unknown;
}

export interface CodexTurnsPage {
  data: CodexTurn[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface CodexItemEntry {
  turnId: string;
  item: CodexItem;
}

export interface CodexItemsPage {
  data: CodexItemEntry[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface CodexThread {
  id: string;
  name?: string;
  preview?: string;
  cwd?: string;
  model?: string;
  isPinned?: boolean;
  createdAt?: number | string;
  updatedAt?: number | string;
  recencyAt?: number | string | null;
  historyMode?: "legacy" | "paginated";
  status?: string | Record<string, unknown>;
  turns?: CodexTurn[];
  [key: string]: unknown;
}

export interface ThreadSettings {
  cwd: string;
  model: string;
  effort: string;
  sandbox: "workspace-write" | "read-only" | "danger-full-access" | "external";
}

export interface ReasoningEffortOption {
  reasoningEffort: string;
  description?: string;
}

export interface ModelInfo {
  model: string;
  displayName: string;
  supportedReasoningEfforts: ReasoningEffortOption[];
  inputModalities?: InputModality[];
  defaultReasoningEffort?: string;
  isDefault?: boolean;
}

export type SkillScope = "user" | "repo" | "system" | "admin";

export interface SkillInfo {
  name: string;
  description: string;
  shortDescription?: string;
  scope: SkillScope;
  enabled: boolean;
}

export interface SkillsDirectoryEntry {
  cwd: string;
  skills: SkillInfo[];
  errorCount: number;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface AccountUsageSummary {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
}

export interface AccountUsageDailyBucket {
  startDate: string;
  tokens: number;
}

export interface AccountUsageSnapshot {
  summary: AccountUsageSummary;
  dailyUsageBuckets: AccountUsageDailyBucket[] | null;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: CreditsSnapshot | null;
  spendControlReached: boolean | null;
  planType: string | null;
  rateLimitReachedType: string | null;
}

export interface AccountRateLimitsSnapshot {
  rateLimits: RateLimitSnapshot | null;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null;
}

export type ActivityKind =
  | "waitingApproval"
  | "waitingInput"
  | "running"
  | "systemError"
  | "failed"
  | "interrupted"
  | "completed"
  | "updated";

export interface ThreadActivityEvent {
  threadId: string;
  turnId?: string;
  kind: ActivityKind;
  occurredAt: number;
  durationMs?: number;
}

export interface ChoiceOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  id: string;
  header?: string;
  question: string;
  options?: ChoiceOption[];
  isOther?: boolean;
  isSecret?: boolean;
  [key: string]: unknown;
}

export interface PendingRequest {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
  receivedAt: number;
}

export interface ToastMessage {
  id: number;
  tone: "error" | "info" | "success";
  message: string;
}

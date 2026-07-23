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
  diff?: string;
  plan?: TurnPlan;
  recoveryOmissions?: string[];
  historyDetail?: {
    cursor: string | null;
    status: "idle" | "loading" | "error";
    error: string | null;
  };
  [key: string]: unknown;
}

export interface CodexTurnsPage {
  data: CodexTurn[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface CodexThread {
  id: string;
  name?: string;
  preview?: string;
  cwd?: string;
  model?: string;
  createdAt?: number | string;
  updatedAt?: number | string;
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
  defaultReasoningEffort?: string;
  isDefault?: boolean;
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

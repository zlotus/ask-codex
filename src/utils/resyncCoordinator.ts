import type { CodexThread, NotificationMessage } from "../types/protocol";

const DEFAULT_MAX_MESSAGES = 128;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REASONING_PARTS = 16;

interface ResyncCoordinatorOptions {
  maxMessages?: number;
  maxBytes?: number;
}

export interface ResyncPassResult {
  notifications: NotificationMessage[];
  rerun: boolean;
  restart: boolean;
}

interface DeltaDescriptor {
  key: string;
  delta: string;
  field: string;
  index?: number;
  turnId: string;
  itemId: string;
}

function serializedBytes(message: NotificationMessage): number {
  try {
    return new TextEncoder().encode(JSON.stringify(message)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function shouldBufferDuringResync(message: NotificationMessage): boolean {
  return message.method.startsWith("thread/") ||
    message.method.startsWith("turn/") ||
    message.method.startsWith("item/");
}

function deltaDescriptor(message: NotificationMessage): DeltaDescriptor | null {
  if (typeof message.params !== "object" || message.params === null || Array.isArray(message.params)) {
    return null;
  }
  const params = message.params as Record<string, unknown>;
  const turnId = params.turnId;
  const itemId = params.itemId;
  const delta = params.delta;
  if (typeof turnId !== "string" || typeof itemId !== "string" || typeof delta !== "string") {
    return null;
  }

  let field: string;
  let index: number | undefined;
  switch (message.method) {
    case "item/agentMessage/delta":
    case "item/plan/delta":
      field = "text";
      break;
    case "item/commandExecution/outputDelta":
      field = "aggregatedOutput";
      break;
    case "item/fileChange/outputDelta":
      field = "output";
      break;
    case "item/reasoning/summaryTextDelta":
      field = "summary";
      index = Number.isSafeInteger(params.summaryIndex) &&
        (params.summaryIndex as number) >= 0 &&
        (params.summaryIndex as number) < MAX_REASONING_PARTS
        ? params.summaryIndex as number
        : undefined;
      if (index === undefined) return null;
      break;
    case "item/reasoning/textDelta":
      field = "content";
      index = Number.isSafeInteger(params.contentIndex) &&
        (params.contentIndex as number) >= 0 &&
        (params.contentIndex as number) < MAX_REASONING_PARTS
        ? params.contentIndex as number
        : undefined;
      if (index === undefined) return null;
      break;
    default:
      return null;
  }

  return {
    key: JSON.stringify([turnId, itemId, field, index ?? null]),
    delta,
    field,
    ...(index === undefined ? {} : { index }),
    turnId,
    itemId,
  };
}

function itemField(
  thread: CodexThread | null,
  descriptor: DeltaDescriptor,
): { value: string; canonical: boolean } | null {
  const turn = thread?.turns?.find((entry) => entry.id === descriptor.turnId);
  const item = turn?.items.find((entry) => entry.id === descriptor.itemId);
  if (!turn || !item) return null;
  const raw = item[descriptor.field];
  const value = descriptor.index === undefined
    ? raw
    : Array.isArray(raw) ? raw[descriptor.index] : undefined;
  if (typeof value !== "string") return null;
  return {
    value,
    canonical: turn.itemsView === "full" && turn.status !== "inProgress",
  };
}

function coveredDeltaCharacters(
  baseline: CodexThread | null,
  snapshot: CodexThread,
  descriptor: DeltaDescriptor,
  combinedDelta: string,
): number {
  const snapshotField = itemField(snapshot, descriptor);
  if (!snapshotField) return 0;
  if (snapshotField.canonical) return combinedDelta.length;

  const baselineValue = itemField(baseline, descriptor)?.value ?? "";
  if (snapshotField.value === baselineValue) return 0;
  if (snapshotField.value.startsWith(baselineValue)) {
    const appended = snapshotField.value.slice(baselineValue.length);
    if (combinedDelta.startsWith(appended)) return appended.length;
  }
  return snapshotField.value.endsWith(combinedDelta) ? combinedDelta.length : 0;
}

function planNotificationCoveredBySnapshot(
  snapshot: CodexThread,
  message: NotificationMessage,
): boolean {
  if (message.method !== "turn/plan/updated") return false;
  if (typeof message.params !== "object" || message.params === null || Array.isArray(message.params)) {
    return false;
  }
  const params = message.params as Record<string, unknown>;
  if (params.threadId !== snapshot.id || typeof params.turnId !== "string") return false;
  const turn = snapshot.turns?.find((candidate) => candidate.id === params.turnId);
  return turn !== undefined && Object.hasOwn(turn, "plan");
}

export function filterSnapshotCoveredNotifications(
  baseline: CodexThread | null,
  snapshot: CodexThread,
  notifications: NotificationMessage[],
): NotificationMessage[] {
  const groups = new Map<string, { descriptor: DeltaDescriptor; combined: string }>();
  for (const message of notifications) {
    const descriptor = deltaDescriptor(message);
    if (!descriptor) continue;
    const group = groups.get(descriptor.key);
    if (group) group.combined += descriptor.delta;
    else groups.set(descriptor.key, { descriptor, combined: descriptor.delta });
  }

  const remainingCovered = new Map<string, number>();
  for (const [key, group] of groups) {
    remainingCovered.set(
      key,
      coveredDeltaCharacters(baseline, snapshot, group.descriptor, group.combined),
    );
  }

  return notifications.flatMap((message) => {
    if (planNotificationCoveredBySnapshot(snapshot, message)) return [];
    const descriptor = deltaDescriptor(message);
    if (!descriptor) return [message];
    const covered = remainingCovered.get(descriptor.key) ?? 0;
    if (covered <= 0) return [message];
    if (covered >= descriptor.delta.length) {
      remainingCovered.set(descriptor.key, covered - descriptor.delta.length);
      return [];
    }
    remainingCovered.set(descriptor.key, 0);
    const params = message.params as Record<string, unknown>;
    return [{ ...message, params: { ...params, delta: descriptor.delta.slice(covered) } }];
  });
}

export class ResyncCoordinator {
  private readonly maxMessages: number;
  private readonly maxBytes: number;
  private notifications: Array<{ message: NotificationMessage; bytes: number }> = [];
  private bufferedBytes = 0;
  private requested = false;
  private running = false;
  private buffering = false;

  constructor(options: ResyncCoordinatorOptions = {}) {
    this.maxMessages = Math.max(1, options.maxMessages ?? DEFAULT_MAX_MESSAGES);
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  }

  request(): void {
    this.requested = true;
    this.buffering = true;
  }

  startCycle(): boolean {
    if (this.running || !this.requested) return false;
    this.running = true;
    this.requested = false;
    return true;
  }

  shouldBuffer(message: NotificationMessage): boolean {
    return this.buffering && shouldBufferDuringResync(message);
  }

  buffer(message: NotificationMessage): void {
    const bytes = serializedBytes(message);
    if (
      bytes > this.maxBytes ||
      this.notifications.length >= this.maxMessages ||
      this.bufferedBytes > this.maxBytes - bytes
    ) {
      this.notifications = [];
      this.bufferedBytes = 0;
      this.requested = true;
    }
    if (bytes <= this.maxBytes) {
      this.notifications.push({ message, bytes });
      this.bufferedBytes += bytes;
    }
  }

  finishPass(allowRerun: boolean): ResyncPassResult {
    const notifications = this.drain();
    if (allowRerun && this.requested) {
      this.requested = false;
      return { notifications, rerun: true, restart: false };
    }

    this.running = false;
    const restart = this.requested;
    if (!restart) this.buffering = false;
    return { notifications, rerun: false, restart };
  }

  abort(): NotificationMessage[] {
    const notifications = this.drain();
    this.requested = false;
    this.running = false;
    this.buffering = false;
    return notifications;
  }

  isBuffering(): boolean {
    return this.buffering;
  }

  private drain(): NotificationMessage[] {
    const notifications = this.notifications.map(({ message }) => message);
    this.notifications = [];
    this.bufferedBytes = 0;
    return notifications;
  }
}

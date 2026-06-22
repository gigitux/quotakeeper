export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export type GuardStatus =
  | "healthy"
  | "warning"
  | "pause_required"
  | "paused"
  | "blocked"
  | "restart_available"
  | "error";

export type GuardReason =
  | "configuration_required"
  | "threshold_reached"
  | "rate_limit_reached"
  | "credits_depleted"
  | "goal_budget_limited"
  | "unknown";

export type RestartMode = "manual" | "automatic";

export interface UsageLimitPolicy {
  fiveHourUsagePercent: number;
  weeklyUsagePercent: number;
}

export interface QuotaPolicy {
  usageLimits: UsageLimitPolicy;
  restartMode: RestartMode;
  limitIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ThreadGoal {
  threadId: string;
  objective: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  tokenBudget?: number | null;
}

export interface ThreadTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
}

export interface ThreadReadResponse {
  thread: {
    id: string;
    turns: ThreadTurn[];
  };
}

export interface RateLimitWindow {
  usedPercent: number;
  resetsAt?: number | null;
  windowDurationMins?: number | null;
}

export interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  individualLimit?: {
    limit: string;
    remainingPercent: number;
    resetsAt: number;
    used: string;
  } | null;
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    balance?: string | null;
  } | null;
  rateLimitReachedType?: string | null;
}

export interface RateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null;
  rateLimitResetCredits?: { availableCount: number } | null;
}

export interface NormalizedRateLimit {
  limitId: string;
  limitName?: string | null;
  planType?: string | null;
  usedPercent: number;
  remainingPercent: number;
  resetsAt?: number | null;
  windowDurationMins?: number | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: RateLimitSnapshot["credits"];
  rateLimitReachedType?: string | null;
}

export interface GuardEvaluation {
  status: GuardStatus;
  reason: GuardReason;
  message?: string;
  goal?: ThreadGoal | null;
  policy?: QuotaPolicy;
  rateLimits: NormalizedRateLimit[];
  nextEvaluationAt?: string | null;
  checkpoint?: CheckpointMetadata;
}

export interface CheckpointMetadata {
  id: string;
  path: string;
  createdAt: string;
}

export interface Checkpoint {
  id: string;
  threadId: string;
  turnId?: string;
  reason: GuardReason;
  summary: string;
  createdAt: string;
  goal?: ThreadGoal | null;
  policy: QuotaPolicy;
  rateLimits: NormalizedRateLimit[];
}

export interface JsonRpcClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify?(method: string, params?: unknown): void;
  onNotification?(handler: (method: string, params: unknown) => void): void;
  close(): Promise<void>;
}

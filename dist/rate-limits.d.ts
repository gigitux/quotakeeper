import type { GuardEvaluation, GuardReason, NormalizedRateLimit, QuotaPolicy, RateLimitsResponse, ThreadGoal } from "./types.js";
export declare function normalizeRateLimits(response: RateLimitsResponse, limitIds?: string[]): NormalizedRateLimit[];
export declare function evaluateGuard(rateLimits: NormalizedRateLimit[], policy: QuotaPolicy, goal?: ThreadGoal | null): GuardEvaluation;
export declare function isHardStop(reason: GuardReason): boolean;

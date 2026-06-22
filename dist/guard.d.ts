import type { Checkpoint, CheckpointMetadata, GuardEvaluation, GuardReason, JsonRpcClient, QuotaPolicy } from "./types.js";
export interface GuardContext {
    cwd: string;
    threadId: string;
    turnId?: string;
    client?: JsonRpcClient;
}
export declare function createClient(): Promise<JsonRpcClient>;
export declare function checkStatus(context: GuardContext): Promise<GuardEvaluation>;
export declare function blockForConfigurationRequired(context: GuardContext, summary: string): Promise<GuardEvaluation>;
export declare function createCheckpoint(context: GuardContext, reason: GuardReason, summary: string, supplied?: Partial<Pick<Checkpoint, "goal" | "policy" | "rateLimits">>): Promise<CheckpointMetadata>;
export declare function pauseGoal(context: GuardContext, reason: GuardReason, summary: string): Promise<GuardEvaluation>;
export declare function resumeGoal(context: GuardContext, force?: boolean): Promise<GuardEvaluation>;
export declare function monitorOnce(context: GuardContext): Promise<GuardEvaluation>;
export declare function monitor(context: GuardContext, pollIntervalSeconds: number): Promise<void>;
export declare function requirePolicy(cwd: string, threadId: string): Promise<QuotaPolicy>;
export declare class MissingPolicyError extends Error {
    constructor(threadId: string);
}
export declare function findActiveTurnId(client: JsonRpcClient, threadId: string): Promise<string | undefined>;

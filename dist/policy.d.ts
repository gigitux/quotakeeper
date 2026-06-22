import type { QuotaPolicy } from "./types.js";
export declare class IncompletePolicyConfigurationError extends Error {
    constructor(missing: string[]);
}
export interface ConfigurePolicyOptions {
    cwd: string;
    threadId: string;
    fiveHourUsagePercent?: number;
    weeklyUsagePercent?: number;
    restartMode?: string;
    limitIds?: string[];
    interactive?: boolean;
}
export declare function policyPath(cwd: string, threadId: string): string;
export declare function loadPolicy(cwd: string, threadId: string): Promise<QuotaPolicy | null>;
export declare function savePolicy(cwd: string, threadId: string, policy: QuotaPolicy): Promise<string>;
export declare function configurePolicy(options: ConfigurePolicyOptions): Promise<{
    policy: QuotaPolicy;
    path: string;
}>;

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { StdioAppServerClient } from "./app-server.js";
import { loadPolicy } from "./policy.js";
import { evaluateGuard, normalizeRateLimits } from "./rate-limits.js";
export async function createClient() {
    return StdioAppServerClient.create();
}
export async function checkStatus(context) {
    const client = context.client ?? (await createClient());
    try {
        const policy = await requirePolicy(context.cwd, context.threadId);
        const [rateLimitResponse, goalResponse] = await Promise.all([
            client.request("account/rateLimits/read"),
            client.request("thread/goal/get", {
                threadId: context.threadId,
            }),
        ]);
        const rateLimits = normalizeRateLimits(rateLimitResponse, policy.limitIds);
        return evaluateGuard(rateLimits, policy, goalResponse.goal);
    }
    finally {
        if (!context.client) {
            await client.close();
        }
    }
}
export async function blockForConfigurationRequired(context, summary) {
    const client = context.client ?? (await createClient());
    try {
        const goal = await readGoalIfAvailable(client, context.threadId);
        await client.request("thread/goal/set", {
            threadId: context.threadId,
            status: "blocked",
        });
        const turnId = context.turnId ?? (await findActiveTurnIdIfAvailable(client, context.threadId));
        if (turnId) {
            await client.request("turn/interrupt", {
                threadId: context.threadId,
                turnId,
            });
        }
        return {
            status: "blocked",
            reason: "configuration_required",
            message: summary,
            goal,
            rateLimits: [],
            nextEvaluationAt: null,
        };
    }
    finally {
        if (!context.client) {
            await client.close();
        }
    }
}
export async function createCheckpoint(context, reason, summary, supplied) {
    const policy = supplied?.policy ?? (await requirePolicy(context.cwd, context.threadId));
    const evaluation = supplied?.rateLimits
        ? { goal: supplied.goal, rateLimits: supplied.rateLimits }
        : await checkStatus(context);
    const createdAt = new Date().toISOString();
    const id = `checkpoint-${createdAt.replace(/[:.]/g, "-")}`;
    const target = path.join(context.cwd, ".quota-keeper", "checkpoints", context.threadId, `${id}.json`);
    const checkpoint = {
        id,
        threadId: context.threadId,
        turnId: context.turnId,
        reason,
        summary,
        createdAt,
        goal: evaluation.goal,
        policy,
        rateLimits: evaluation.rateLimits,
    };
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    return { id, path: target, createdAt };
}
export async function pauseGoal(context, reason, summary) {
    const client = context.client ?? (await createClient());
    try {
        const evaluation = await checkStatus({ ...context, client });
        const turnId = context.turnId ?? (await findActiveTurnId(client, context.threadId));
        const checkpoint = await createCheckpoint({ ...context, turnId }, reason, summary, {
            goal: evaluation.goal,
            policy: evaluation.policy,
            rateLimits: evaluation.rateLimits,
        });
        await client.request("thread/goal/set", {
            threadId: context.threadId,
            status: "paused",
        });
        if (turnId) {
            await client.request("turn/interrupt", {
                threadId: context.threadId,
                turnId,
            });
        }
        return { ...evaluation, status: "paused", reason, checkpoint };
    }
    finally {
        if (!context.client) {
            await client.close();
        }
    }
}
export async function resumeGoal(context, force = false) {
    const client = context.client ?? (await createClient());
    try {
        const policy = await requirePolicy(context.cwd, context.threadId);
        if (policy.restartMode !== "automatic" && !force) {
            const evaluation = await checkStatus({ ...context, client });
            return { ...evaluation, status: "restart_available", reason: "threshold_reached" };
        }
        const checkpoint = await latestCheckpoint(context.cwd, context.threadId);
        await client.request("thread/goal/set", {
            threadId: context.threadId,
            status: "active",
        });
        await client.request("turn/start", {
            threadId: context.threadId,
            input: [
                {
                    type: "text",
                    text: resumePrompt(checkpoint),
                },
            ],
        });
        const evaluation = await checkStatus({ ...context, client });
        return {
            ...evaluation,
            status: "healthy",
            reason: "unknown",
            checkpoint: checkpointMetadata(checkpoint),
        };
    }
    finally {
        if (!context.client) {
            await client.close();
        }
    }
}
export async function monitorOnce(context) {
    let evaluation;
    try {
        evaluation = await checkStatus(context);
    }
    catch (error) {
        if (error instanceof MissingPolicyError) {
            return blockForConfigurationRequired(context, `QuotaKeeper blocked this Goal because ${error.message}`);
        }
        throw error;
    }
    if (evaluation.status === "pause_required") {
        return pauseGoal(context, evaluation.reason, "QuotaKeeper paused this Goal because the configured quota policy was reached.");
    }
    if (evaluation.status === "restart_available" && evaluation.policy?.restartMode === "automatic") {
        return resumeGoal(context);
    }
    return evaluation;
}
export async function monitor(context, pollIntervalSeconds) {
    try {
        await requirePolicy(context.cwd, context.threadId);
    }
    catch (error) {
        if (error instanceof MissingPolicyError) {
            const result = await blockForConfigurationRequired(context, `QuotaKeeper blocked this Goal because ${error.message}`);
            process.stdout.write(`${JSON.stringify(result)}\n`);
            return;
        }
        throw error;
    }
    let latestTurnId = context.turnId;
    const client = context.client ?? (await createClient());
    client.onNotification?.((method, params) => {
        if (method === "turn/started" &&
            isObject(params) &&
            isObject(params.turn) &&
            typeof params.turn.id === "string") {
            latestTurnId = params.turn.id;
        }
    });
    try {
        for (;;) {
            const result = await monitorOnce({ ...context, turnId: latestTurnId, client });
            process.stdout.write(`${JSON.stringify(result)}\n`);
            await new Promise((resolve) => setTimeout(resolve, pollIntervalSeconds * 1000));
        }
    }
    finally {
        if (!context.client) {
            await client.close();
        }
    }
}
export async function requirePolicy(cwd, threadId) {
    const policy = await loadPolicy(cwd, threadId);
    if (!policy) {
        throw new MissingPolicyError(threadId);
    }
    return policy;
}
export class MissingPolicyError extends Error {
    constructor(threadId) {
        super(`QuotaKeeper policy is missing for thread ${threadId}. Run configure-goal first.`);
        this.name = "MissingPolicyError";
    }
}
export async function findActiveTurnId(client, threadId) {
    const response = await client.request("thread/read", {
        threadId,
        includeTurns: true,
    });
    for (let index = response.thread.turns.length - 1; index >= 0; index -= 1) {
        const turn = response.thread.turns[index];
        if (turn.status === "inProgress") {
            return turn.id;
        }
    }
    return undefined;
}
async function readGoalIfAvailable(client, threadId) {
    try {
        const response = await client.request("thread/goal/get", {
            threadId,
        });
        return response.goal;
    }
    catch {
        return null;
    }
}
async function findActiveTurnIdIfAvailable(client, threadId) {
    try {
        return await findActiveTurnId(client, threadId);
    }
    catch {
        return undefined;
    }
}
async function latestCheckpoint(cwd, threadId) {
    const directory = path.join(cwd, ".quota-keeper", "checkpoints", threadId);
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
    if (!files.length) {
        throw new Error(`No QuotaKeeper checkpoint found for thread ${threadId}.`);
    }
    return JSON.parse(await readFile(path.join(directory, files[files.length - 1]), "utf8"));
}
function checkpointMetadata(checkpoint) {
    return {
        id: checkpoint.id,
        path: path.join(".quota-keeper", "checkpoints", checkpoint.threadId, `${checkpoint.id}.json`),
        createdAt: checkpoint.createdAt,
    };
}
function resumePrompt(checkpoint) {
    return [
        "QuotaKeeper detected that quota is available again. Resume the Goal from this checkpoint.",
        `Checkpoint: ${checkpoint.id}`,
        `Pause reason: ${checkpoint.reason}`,
        `Progress summary: ${checkpoint.summary}`,
    ].join("\n");
}
function isObject(value) {
    return typeof value === "object" && value !== null;
}
//# sourceMappingURL=guard.js.map
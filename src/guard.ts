import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { StdioAppServerClient } from "./app-server.js";
import { loadPolicy } from "./policy.js";
import { evaluateGuard, normalizeRateLimits } from "./rate-limits.js";
import type {
  Checkpoint,
  CheckpointMetadata,
  GuardEvaluation,
  GuardReason,
  JsonRpcClient,
  QuotaPolicy,
  RateLimitsResponse,
  ThreadReadResponse,
  ThreadGoal,
} from "./types.js";

export interface GuardContext {
  cwd: string;
  threadId: string;
  turnId?: string;
  client?: JsonRpcClient;
}

export async function createClient(): Promise<JsonRpcClient> {
  return StdioAppServerClient.create();
}

export async function checkStatus(context: GuardContext): Promise<GuardEvaluation> {
  const client = context.client ?? (await createClient());
  try {
    const policy = await requirePolicy(context.cwd, context.threadId);
    const [rateLimitResponse, goalResponse] = await Promise.all([
      client.request<RateLimitsResponse>("account/rateLimits/read"),
      client.request<{ goal: ThreadGoal | null }>("thread/goal/get", {
        threadId: context.threadId,
      }),
    ]);
    const rateLimits = normalizeRateLimits(rateLimitResponse, policy.limitIds);
    return evaluateGuard(rateLimits, policy, goalResponse.goal);
  } finally {
    if (!context.client) {
      await client.close();
    }
  }
}

export async function blockForConfigurationRequired(
  context: GuardContext,
  summary: string,
): Promise<GuardEvaluation> {
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
  } finally {
    if (!context.client) {
      await client.close();
    }
  }
}

export async function createCheckpoint(
  context: GuardContext,
  reason: GuardReason,
  summary: string,
  supplied?: Partial<Pick<Checkpoint, "goal" | "policy" | "rateLimits">>,
): Promise<CheckpointMetadata> {
  const policy = supplied?.policy ?? (await requirePolicy(context.cwd, context.threadId));
  const evaluation = supplied?.rateLimits
    ? { goal: supplied.goal, rateLimits: supplied.rateLimits }
    : await checkStatus(context);
  const createdAt = new Date().toISOString();
  const id = `checkpoint-${createdAt.replace(/[:.]/g, "-")}`;
  const target = path.join(
    context.cwd,
    ".quota-keeper",
    "checkpoints",
    context.threadId,
    `${id}.json`,
  );
  const checkpoint: Checkpoint = {
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

export async function pauseGoal(
  context: GuardContext,
  reason: GuardReason,
  summary: string,
): Promise<GuardEvaluation> {
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
  } finally {
    if (!context.client) {
      await client.close();
    }
  }
}

export async function resumeGoal(context: GuardContext, force = false): Promise<GuardEvaluation> {
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
  } finally {
    if (!context.client) {
      await client.close();
    }
  }
}

export async function monitorOnce(context: GuardContext): Promise<GuardEvaluation> {
  let evaluation: GuardEvaluation;
  try {
    evaluation = await checkStatus(context);
  } catch (error) {
    if (error instanceof MissingPolicyError) {
      return blockForConfigurationRequired(
        context,
        `QuotaKeeper blocked this Goal because ${error.message}`,
      );
    }
    throw error;
  }
  if (evaluation.status === "pause_required") {
    return pauseGoal(
      context,
      evaluation.reason,
      "QuotaKeeper paused this Goal because the configured quota policy was reached.",
    );
  }
  if (evaluation.status === "restart_available" && evaluation.policy?.restartMode === "automatic") {
    return resumeGoal(context);
  }
  return evaluation;
}

export async function monitor(context: GuardContext, pollIntervalSeconds: number): Promise<void> {
  try {
    await requirePolicy(context.cwd, context.threadId);
  } catch (error) {
    if (error instanceof MissingPolicyError) {
      const result = await blockForConfigurationRequired(
        context,
        `QuotaKeeper blocked this Goal because ${error.message}`,
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    throw error;
  }
  let latestTurnId = context.turnId;
  const client = context.client ?? (await createClient());
  client.onNotification?.((method, params) => {
    if (
      method === "turn/started" &&
      isObject(params) &&
      isObject(params.turn) &&
      typeof params.turn.id === "string"
    ) {
      latestTurnId = params.turn.id;
    }
  });

  try {
    for (;;) {
      const result = await monitorOnce({ ...context, turnId: latestTurnId, client });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      await new Promise((resolve) => setTimeout(resolve, pollIntervalSeconds * 1000));
    }
  } finally {
    if (!context.client) {
      await client.close();
    }
  }
}

export async function requirePolicy(cwd: string, threadId: string): Promise<QuotaPolicy> {
  const policy = await loadPolicy(cwd, threadId);
  if (!policy) {
    throw new MissingPolicyError(threadId);
  }
  return policy;
}

export class MissingPolicyError extends Error {
  constructor(threadId: string) {
    super(`QuotaKeeper policy is missing for thread ${threadId}. Run configure-goal first.`);
    this.name = "MissingPolicyError";
  }
}

export async function findActiveTurnId(
  client: JsonRpcClient,
  threadId: string,
): Promise<string | undefined> {
  const response = await client.request<ThreadReadResponse>("thread/read", {
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

async function readGoalIfAvailable(
  client: JsonRpcClient,
  threadId: string,
): Promise<ThreadGoal | null> {
  try {
    const response = await client.request<{ goal: ThreadGoal | null }>("thread/goal/get", {
      threadId,
    });
    return response.goal;
  } catch {
    return null;
  }
}

async function findActiveTurnIdIfAvailable(
  client: JsonRpcClient,
  threadId: string,
): Promise<string | undefined> {
  try {
    return await findActiveTurnId(client, threadId);
  } catch {
    return undefined;
  }
}

async function latestCheckpoint(cwd: string, threadId: string): Promise<Checkpoint> {
  const directory = path.join(cwd, ".quota-keeper", "checkpoints", threadId);
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
  if (!files.length) {
    throw new Error(`No QuotaKeeper checkpoint found for thread ${threadId}.`);
  }
  return JSON.parse(
    await readFile(path.join(directory, files[files.length - 1]), "utf8"),
  ) as Checkpoint;
}

function checkpointMetadata(checkpoint: Checkpoint): CheckpointMetadata {
  return {
    id: checkpoint.id,
    path: path.join(".quota-keeper", "checkpoints", checkpoint.threadId, `${checkpoint.id}.json`),
    createdAt: checkpoint.createdAt,
  };
}

function resumePrompt(checkpoint: Checkpoint): string {
  return [
    "QuotaKeeper detected that quota is available again. Resume the Goal from this checkpoint.",
    `Checkpoint: ${checkpoint.id}`,
    `Pause reason: ${checkpoint.reason}`,
    `Progress summary: ${checkpoint.summary}`,
  ].join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

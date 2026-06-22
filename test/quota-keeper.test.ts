import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configurePolicy } from "../src/policy.js";
import {
  blockForConfigurationRequired,
  checkStatus,
  monitorOnce,
  pauseGoal,
  resumeGoal,
} from "../src/guard.js";
import { normalizeRateLimits } from "../src/rate-limits.js";
import { FakeClient } from "./fake-client.js";

test("configure-goal rejects missing answers without .goalkeeper", async () => {
  const cwd = await tempDir();
  try {
    await assert.rejects(
      configurePolicy({
        cwd,
        threadId: "thread-1",
        interactive: false,
      }),
      /configuration is incomplete/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("configure-goal reads usage limits from .goalkeeper JSON", async () => {
  const cwd = await tempDir();
  try {
    await writeFile(
      path.join(cwd, ".goalkeeper"),
      JSON.stringify({
        fiveHourUsagePercent: 80,
        weeklyUsagePercent: 92,
        restartMode: "automatic",
      }),
    );
    const result = await configurePolicy({
      cwd,
      threadId: "thread-1",
      interactive: false,
    });
    assert.deepEqual(result.policy.usageLimits, {
      fiveHourUsagePercent: 80,
      weeklyUsagePercent: 92,
    });
    assert.equal(result.policy.restartMode, "automatic");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("configure-goal reads usage limits from .goalkeeper key-value config", async () => {
  const cwd = await tempDir();
  try {
    await writeFile(
      path.join(cwd, ".goalkeeper"),
      ["fiveHourUsagePercent=75", "weeklyUsagePercent=0", "restartMode=manual"].join("\n"),
    );
    const result = await configurePolicy({
      cwd,
      threadId: "thread-1",
      interactive: false,
    });
    assert.deepEqual(result.policy.usageLimits, {
      fiveHourUsagePercent: 75,
      weeklyUsagePercent: 0,
    });
    assert.equal(result.policy.restartMode, "manual");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("configure-goal rejects incomplete .goalkeeper config", async () => {
  const cwd = await tempDir();
  try {
    await writeFile(
      path.join(cwd, ".goalkeeper"),
      ["fiveHourUsagePercent=75", "weeklyUsagePercent=0"].join("\n"),
    );
    await assert.rejects(
      configurePolicy({
        cwd,
        threadId: "thread-1",
        interactive: false,
      }),
      /Missing: restart mode/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("configure-goal rejects blank .goalkeeper values", async () => {
  const cwd = await tempDir();
  try {
    await writeFile(
      path.join(cwd, ".goalkeeper"),
      JSON.stringify({
        fiveHourUsagePercent: "",
        weeklyUsagePercent: 0,
        restartMode: "",
      }),
    );
    await assert.rejects(
      configurePolicy({
        cwd,
        threadId: "thread-1",
        interactive: false,
      }),
      /Missing: 5-hour usage limit percent, restart mode/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("configure-goal rejects usage aliases in .goalkeeper", async () => {
  const cwd = await tempDir();
  try {
    await writeFile(path.join(cwd, ".goalkeeper"), ["fiveHourUsage=75"].join("\n"));
    await assert.rejects(
      configurePolicy({
        cwd,
        threadId: "thread-1",
        interactive: false,
      }),
      /Unsupported .goalkeeper key "fiveHourUsage"/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("configure-goal persists usage limit options", async () => {
  const cwd = await tempDir();
  try {
    const result = await configurePolicy({
      cwd,
      threadId: "thread-1",
      fiveHourUsagePercent: 88,
      weeklyUsagePercent: 40,
      restartMode: "automatic",
      interactive: false,
    });
    assert.deepEqual(result.policy.usageLimits, {
      fiveHourUsagePercent: 88,
      weeklyUsagePercent: 40,
    });
    assert.equal(result.policy.restartMode, "automatic");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("monitoring blocks the Goal without a per-goal policy", async () => {
  const cwd = await tempDir();
  const client = fakeGoalClient("active", "turn-active");
  client.setResponse("thread/goal/set", {});
  client.setResponse("turn/interrupt", {});
  try {
    const result = await monitorOnce({ cwd, threadId: "thread-1", client });
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "configuration_required");
    assert.deepEqual(
      client.requests.find((request) => request.method === "thread/goal/set")?.params,
      { threadId: "thread-1", status: "blocked" },
    );
    assert.deepEqual(
      client.requests.find((request) => request.method === "turn/interrupt")?.params,
      { threadId: "thread-1", turnId: "turn-active" },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("configuration-required block does not need a saved policy", async () => {
  const cwd = await tempDir();
  const client = fakeGoalClient("active", "turn-active");
  client.setResponse("thread/goal/set", {});
  client.setResponse("turn/interrupt", {});
  try {
    const result = await blockForConfigurationRequired(
      { cwd, threadId: "thread-1", client },
      "Missing policy answers.",
    );
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "configuration_required");
    assert.ok(client.requests.some((request) => request.method === "thread/goal/set"));
    assert.ok(client.requests.some((request) => request.method === "turn/interrupt"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("healthy quota returns healthy", async () => {
  const cwd = await configuredTempDir();
  const client = fakeStatusClient(40, "active");
  try {
    const result = await checkStatus({ cwd, threadId: "thread-1", client });
    assert.equal(result.status, "healthy");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("pause threshold returns pause_required", async () => {
  const cwd = await configuredTempDir();
  const client = fakeStatusClient(90, "active");
  try {
    const result = await checkStatus({ cwd, threadId: "thread-1", client });
    assert.equal(result.status, "pause_required");
    assert.equal(result.reason, "threshold_reached");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("5-hour usage limit returns pause_required independently of weekly usage", async () => {
  const cwd = await configuredUsageTempDir({ fiveHourUsagePercent: 70, weeklyUsagePercent: 95 });
  const client = fakeStatusClient(71, "active", undefined, undefined, 40);
  try {
    const result = await checkStatus({ cwd, threadId: "thread-1", client });
    assert.equal(result.status, "pause_required");
    assert.equal(result.reason, "threshold_reached");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("0 usage limit is treated as unlimited", async () => {
  const cwd = await configuredUsageTempDir({ fiveHourUsagePercent: 0, weeklyUsagePercent: 0 });
  const client = fakeStatusClient(100, "active", undefined, undefined, 100);
  try {
    const result = await checkStatus({ cwd, threadId: "thread-1", client });
    assert.equal(result.status, "healthy");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("restart threshold returns restart_available for paused goals", async () => {
  const cwd = await configuredTempDir();
  const client = fakeStatusClient(50, "paused");
  try {
    const result = await checkStatus({ cwd, threadId: "thread-1", client });
    assert.equal(result.status, "restart_available");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("paused goal sends thread goal update", async () => {
  const cwd = await configuredTempDir();
  const client = fakeStatusClient(90, "active");
  client.setResponse("thread/goal/set", {});
  try {
    const result = await pauseGoal(
      { cwd, threadId: "thread-1", client },
      "threshold_reached",
      "Testing pause.",
    );
    assert.equal(result.status, "paused");
    assert.ok(client.requests.some((request) => request.method === "thread/goal/set"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("threshold pause discovers and interrupts the active turn", async () => {
  const cwd = await configuredTempDir();
  const client = fakeStatusClient(90, "active", undefined, "turn-active");
  client.setResponse("thread/goal/set", {});
  client.setResponse("turn/interrupt", {});
  try {
    await pauseGoal(
      { cwd, threadId: "thread-1", client },
      "threshold_reached",
      "Testing discovered active turn pause.",
    );
    assert.deepEqual(
      client.requests.find((request) => request.method === "turn/interrupt")?.params,
      { threadId: "thread-1", turnId: "turn-active" },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("hard exhaustion sends turn interrupt when turn id is available", async () => {
  const cwd = await configuredTempDir();
  const client = fakeStatusClient(100, "active", "rate_limit_reached");
  client.setResponse("thread/goal/set", {});
  client.setResponse("turn/interrupt", {});
  try {
    await pauseGoal(
      { cwd, threadId: "thread-1", turnId: "turn-1", client },
      "rate_limit_reached",
      "Testing hard pause.",
    );
    assert.ok(client.requests.some((request) => request.method === "turn/interrupt"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("automatic restart only runs when policy enables it", async () => {
  const manualCwd = await configuredTempDir("manual");
  const autoCwd = await configuredTempDir("automatic");
  try {
    const manual = fakeStatusClient(50, "paused");
    const manualResult = await resumeGoal({ cwd: manualCwd, threadId: "thread-1", client: manual });
    assert.equal(manualResult.status, "restart_available");
    assert.equal(
      manual.requests.some((request) => request.method === "turn/start"),
      false,
    );

    const automatic = fakeStatusClient(50, "paused");
    automatic.setResponse("thread/goal/set", {});
    automatic.setResponse("turn/start", {});
    const checkpointDir = path.join(autoCwd, ".quota-keeper", "checkpoints", "thread-1");
    await import("node:fs/promises").then(({ mkdir, writeFile }) =>
      mkdir(checkpointDir, { recursive: true }).then(() =>
        writeFile(
          path.join(checkpointDir, "checkpoint-2026-01-01T00-00-00-000Z.json"),
          JSON.stringify({
            id: "checkpoint-2026-01-01T00-00-00-000Z",
            threadId: "thread-1",
            reason: "threshold_reached",
            summary: "Test",
            createdAt: "2026-01-01T00:00:00.000Z",
            policy: {},
            rateLimits: [],
          }),
        ),
      ),
    );
    const autoResult = await resumeGoal({ cwd: autoCwd, threadId: "thread-1", client: automatic });
    assert.equal(autoResult.status, "healthy");
    assert.ok(automatic.requests.some((request) => request.method === "turn/start"));
  } finally {
    await rm(manualCwd, { recursive: true, force: true });
    await rm(autoCwd, { recursive: true, force: true });
  }
});

test("multiple rate-limit buckets normalize with codex preference", () => {
  const limits = normalizeRateLimits({
    rateLimits: { primary: { usedPercent: 1 } },
    rateLimitsByLimitId: {
      other: { limitId: "other", primary: { usedPercent: 99 } },
      codex: { limitId: "codex", primary: { usedPercent: 42 } },
    },
  });
  assert.equal(limits.length, 1);
  assert.equal(limits[0].limitId, "codex");
  assert.equal(limits[0].usedPercent, 42);
});

async function configuredTempDir(restartMode: "manual" | "automatic" = "manual"): Promise<string> {
  const cwd = await tempDir();
  await configurePolicy({
    cwd,
    threadId: "thread-1",
    fiveHourUsagePercent: 85,
    weeklyUsagePercent: 0,
    restartMode,
    interactive: false,
  });
  return cwd;
}

async function configuredUsageTempDir(usageLimits: {
  fiveHourUsagePercent: number;
  weeklyUsagePercent: number;
}): Promise<string> {
  const cwd = await tempDir();
  await configurePolicy({
    cwd,
    threadId: "thread-1",
    fiveHourUsagePercent: usageLimits.fiveHourUsagePercent,
    weeklyUsagePercent: usageLimits.weeklyUsagePercent,
    restartMode: "manual",
    interactive: false,
  });
  return cwd;
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "quota-keeper-"));
}

function fakeStatusClient(
  usedPercent: number,
  goalStatus: string,
  rateLimitReachedType?: string,
  activeTurnId?: string,
  weeklyUsedPercent?: number,
): FakeClient {
  const client = new FakeClient();
  client.setResponse("account/rateLimits/read", {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent, resetsAt: 1790000000, windowDurationMins: 300 },
      secondary:
        weeklyUsedPercent === undefined
          ? undefined
          : { usedPercent: weeklyUsedPercent, resetsAt: 1790604800, windowDurationMins: 10080 },
      rateLimitReachedType,
    },
  });
  client.setResponse("thread/goal/get", {
    goal: {
      threadId: "thread-1",
      objective: "Test goal",
      status: goalStatus,
      createdAt: 1,
      updatedAt: 2,
      tokensUsed: 10,
      timeUsedSeconds: 20,
      tokenBudget: null,
    },
  });
  client.setResponse("thread/read", {
    thread: {
      id: "thread-1",
      turns: activeTurnId ? [{ id: activeTurnId, status: "inProgress" }] : [],
    },
  });
  return client;
}

function fakeGoalClient(goalStatus: string, activeTurnId?: string): FakeClient {
  const client = new FakeClient();
  client.setResponse("thread/goal/get", {
    goal: {
      threadId: "thread-1",
      objective: "Test goal",
      status: goalStatus,
      createdAt: 1,
      updatedAt: 2,
      tokensUsed: 10,
      timeUsedSeconds: 20,
      tokenBudget: null,
    },
  });
  client.setResponse("thread/read", {
    thread: {
      id: "thread-1",
      turns: activeTurnId ? [{ id: activeTurnId, status: "inProgress" }] : [],
    },
  });
  return client;
}

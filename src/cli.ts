#!/usr/bin/env node
import { configurePolicy, IncompletePolicyConfigurationError } from "./policy.js";
import {
  blockForConfigurationRequired,
  checkStatus,
  createCheckpoint,
  monitor,
  monitorOnce,
  pauseGoal,
  resumeGoal,
} from "./guard.js";
import type { GuardReason } from "./types.js";

interface CliOptions {
  command: string;
  cwd: string;
  threadId?: string;
  turnId?: string;
  fiveHourUsagePercent?: number;
  weeklyUsagePercent?: number;
  restartMode?: string;
  limitIds?: string[];
  reason?: GuardReason;
  summary?: string;
  once?: boolean;
  force?: boolean;
  pollIntervalSeconds?: number;
  json?: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const threadId = options.threadId;

  switch (options.command) {
    case "configure-goal": {
      requireThreadId(threadId);
      try {
        const result = await configurePolicy({
          cwd: options.cwd,
          threadId,
          fiveHourUsagePercent: options.fiveHourUsagePercent,
          weeklyUsagePercent: options.weeklyUsagePercent,
          restartMode: options.restartMode,
          limitIds: options.limitIds,
        });
        print(result);
      } catch (error) {
        if (error instanceof IncompletePolicyConfigurationError) {
          print(
            await blockForConfigurationRequired(
              { cwd: options.cwd, threadId, turnId: options.turnId },
              error.message,
            ),
          );
          return;
        }
        throw error;
      }
      return;
    }
    case "block-unconfigured-goal": {
      requireThreadId(threadId);
      print(
        await blockForConfigurationRequired(
          { cwd: options.cwd, threadId, turnId: options.turnId },
          options.summary ??
            "QuotaKeeper blocked this Goal because required quota policy answers are missing.",
        ),
      );
      return;
    }
    case "check-status": {
      requireThreadId(threadId);
      print(
        await checkStatus({
          cwd: options.cwd,
          threadId,
          turnId: options.turnId,
        }),
      );
      return;
    }
    case "create-checkpoint": {
      requireThreadId(threadId);
      print(
        await createCheckpoint(
          { cwd: options.cwd, threadId, turnId: options.turnId },
          options.reason ?? "unknown",
          options.summary ?? "No progress summary supplied.",
        ),
      );
      return;
    }
    case "pause-goal": {
      requireThreadId(threadId);
      print(
        await pauseGoal(
          { cwd: options.cwd, threadId, turnId: options.turnId },
          options.reason ?? "threshold_reached",
          options.summary ??
            "QuotaKeeper paused this Goal because the configured quota policy was reached.",
        ),
      );
      return;
    }
    case "resume-goal": {
      requireThreadId(threadId);
      print(
        await resumeGoal({ cwd: options.cwd, threadId, turnId: options.turnId }, options.force),
      );
      return;
    }
    case "monitor": {
      requireThreadId(threadId);
      if (options.once) {
        print(
          await monitorOnce({
            cwd: options.cwd,
            threadId,
            turnId: options.turnId,
          }),
        );
        return;
      }
      await monitor(
        { cwd: options.cwd, threadId, turnId: options.turnId },
        options.pollIntervalSeconds ?? 60,
      );
      return;
    }
    default:
      throw new Error(`Unknown command "${options.command}".`);
  }
}

function parseArgs(args: string[]): CliOptions {
  const [command = "help", ...rest] = args;
  const options: CliOptions = {
    command,
    cwd: process.cwd(),
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const value = rest[index + 1];
    switch (arg) {
      case "--thread-id":
        options.threadId = requireValue(arg, value);
        index += 1;
        break;
      case "--turn-id":
        options.turnId = requireValue(arg, value);
        index += 1;
        break;
      case "--cwd":
        options.cwd = requireValue(arg, value);
        index += 1;
        break;
      case "--five-hour-usage":
        options.fiveHourUsagePercent = Number(requireValue(arg, value));
        index += 1;
        break;
      case "--weekly-usage":
        options.weeklyUsagePercent = Number(requireValue(arg, value));
        index += 1;
        break;
      case "--restart":
        options.restartMode = requireValue(arg, value);
        index += 1;
        break;
      case "--limit-ids":
        options.limitIds = requireValue(arg, value)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        index += 1;
        break;
      case "--reason":
        options.reason = requireValue(arg, value) as GuardReason;
        index += 1;
        break;
      case "--summary":
        options.summary = requireValue(arg, value);
        index += 1;
        break;
      case "--poll-interval":
        options.pollIntervalSeconds = Number(requireValue(arg, value));
        index += 1;
        break;
      case "--once":
        options.once = true;
        break;
      case "--force":
        options.force = true;
        break;
      default:
        throw new Error(`Unknown option "${arg}".`);
    }
  }

  return options;
}

function requireThreadId(threadId: string | undefined): asserts threadId is string {
  if (!threadId) {
    throw new Error("Missing --thread-id.");
  }
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

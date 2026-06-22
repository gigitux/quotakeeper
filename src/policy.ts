import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { QuotaPolicy, RestartMode, UsageLimitPolicy } from "./types.js";

export class IncompletePolicyConfigurationError extends Error {
  constructor(missing: string[]) {
    super(
      [
        `QuotaKeeper configuration is incomplete. Missing: ${missing.join(", ")}.`,
        "Answer all configure-goal questions before monitoring or starting the Goal.",
        "Use 0 explicitly for unlimited usage windows.",
      ].join(" "),
    );
    this.name = "IncompletePolicyConfigurationError";
  }
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

interface ProjectConfig {
  fiveHourUsagePercent?: number;
  weeklyUsagePercent?: number;
  restartMode?: string;
  limitIds?: string[];
}

const PROJECT_CONFIG_KEYS = new Set([
  "fiveHourUsagePercent",
  "weeklyUsagePercent",
  "restartMode",
  "limitIds",
]);

export function policyPath(cwd: string, threadId: string): string {
  return path.join(cwd, ".quota-keeper", "goals", threadId, "policy.json");
}

export async function loadPolicy(cwd: string, threadId: string): Promise<QuotaPolicy | null> {
  try {
    return JSON.parse(await readFile(policyPath(cwd, threadId), "utf8")) as QuotaPolicy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function savePolicy(
  cwd: string,
  threadId: string,
  policy: QuotaPolicy,
): Promise<string> {
  const target = policyPath(cwd, threadId);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return target;
}

export async function configurePolicy(
  options: ConfigurePolicyOptions,
): Promise<{ policy: QuotaPolicy; path: string }> {
  const now = new Date().toISOString();
  const existing = await loadPolicy(options.cwd, options.threadId);
  const projectConfig = await loadProjectConfig(options.cwd);
  const answers = projectConfig
    ? projectConfigAnswers(options, projectConfig)
    : options.interactive === false
      ? await nonInteractiveAnswers(options)
      : await interactiveAnswers(options);
  requireCompleteAnswers(answers);
  const usageLimits = normalizeUsageLimits({
    fiveHourUsagePercent: answers.fiveHourUsagePercent,
    weeklyUsagePercent: answers.weeklyUsagePercent,
  });

  const policy: QuotaPolicy = {
    usageLimits,
    restartMode: normalizeRestartMode(answers.restartMode),
    limitIds: answers.limitIds?.length ? answers.limitIds : ["codex"],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const target = await savePolicy(options.cwd, options.threadId, policy);
  return { policy, path: target };
}

async function nonInteractiveAnswers(
  options: ConfigurePolicyOptions,
): Promise<ConfigurePolicyOptions> {
  return options;
}

async function interactiveAnswers(
  options: ConfigurePolicyOptions,
): Promise<ConfigurePolicyOptions> {
  if (!process.stdin.isTTY) {
    return nonInteractiveAnswers(options);
  }

  const rl = createInterface({ input, output });
  try {
    const fiveHourAnswer =
      options.fiveHourUsagePercent ??
      parseOptionalNumber(await rl.question("5-hour usage limit percent (0 for unlimited): "));
    const weeklyAnswer =
      options.weeklyUsagePercent ??
      parseOptionalNumber(await rl.question("Weekly usage limit percent (0 for unlimited): "));
    const modeAnswer =
      options.restartMode ?? (await rl.question("Restart mode [manual/automatic]: "));

    return {
      ...options,
      fiveHourUsagePercent: fiveHourAnswer,
      weeklyUsagePercent: weeklyAnswer,
      restartMode: modeAnswer,
    };
  } finally {
    rl.close();
  }
}

function projectConfigAnswers(
  options: ConfigurePolicyOptions,
  projectConfig: ProjectConfig,
): ConfigurePolicyOptions {
  return {
    ...options,
    fiveHourUsagePercent: options.fiveHourUsagePercent ?? projectConfig.fiveHourUsagePercent,
    weeklyUsagePercent: options.weeklyUsagePercent ?? projectConfig.weeklyUsagePercent,
    restartMode: options.restartMode ?? projectConfig.restartMode,
    limitIds: options.limitIds ?? projectConfig.limitIds,
  };
}

async function loadProjectConfig(cwd: string): Promise<ProjectConfig | null> {
  try {
    return parseProjectConfig(await readFile(path.join(cwd, ".goalkeeper"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function parseProjectConfig(contents: string): ProjectConfig {
  const trimmed = contents.trim();
  const parsed = trimmed.startsWith("{") ? JSON.parse(trimmed) : parseKeyValueConfig(trimmed);
  if (!isObject(parsed)) {
    throw new Error(".goalkeeper must contain a JSON object or key=value pairs.");
  }
  validateProjectConfigKeys(parsed);
  return {
    fiveHourUsagePercent: optionalConfigNumber(parsed, "fiveHourUsagePercent"),
    weeklyUsagePercent: optionalConfigNumber(parsed, "weeklyUsagePercent"),
    restartMode: optionalConfigString(parsed, "restartMode"),
    limitIds: optionalConfigString(parsed, "limitIds")
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

function parseKeyValueConfig(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^(?<key>[A-Za-z0-9_-]+)\s*(?:=|:)\s*(?<value>.+)$/.exec(trimmed);
    if (!match?.groups) {
      throw new Error(`Invalid .goalkeeper line: ${line}`);
    }
    values[match.groups.key] = match.groups.value.trim();
  }
  return values;
}

function validateProjectConfigKeys(values: Record<string, unknown>): void {
  for (const key of Object.keys(values)) {
    if (!PROJECT_CONFIG_KEYS.has(key)) {
      throw new Error(`Unsupported .goalkeeper key "${key}".`);
    }
  }
}

function normalizeUsageLimits(values: {
  fiveHourUsagePercent?: number;
  weeklyUsagePercent?: number;
}): UsageLimitPolicy {
  return {
    fiveHourUsagePercent: normalizePercent(values.fiveHourUsagePercent ?? 0, "5-hour usage limit"),
    weeklyUsagePercent: normalizePercent(values.weeklyUsagePercent ?? 0, "weekly usage limit"),
  };
}

function requireCompleteAnswers(answers: ConfigurePolicyOptions): void {
  const missing = [];
  if (answers.fiveHourUsagePercent === undefined) {
    missing.push("5-hour usage limit percent");
  }
  if (answers.weeklyUsagePercent === undefined) {
    missing.push("weekly usage limit percent");
  }
  if (!answers.restartMode?.trim()) {
    missing.push("restart mode");
  }
  if (missing.length) {
    throw new IncompletePolicyConfigurationError(missing);
  }
}

function optionalConfigNumber(
  values: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  const value = optionalConfigValue(values, ...keys);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && !value.trim()) {
    return undefined;
  }
  return Number(value);
}

function optionalConfigString(
  values: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  const value = optionalConfigValue(values, ...keys);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string" && !value.trim()) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.join(",");
  }
  return String(value);
}

function optionalConfigValue(
  values: Record<string, unknown>,
  ...keys: string[]
): unknown | undefined {
  for (const key of keys) {
    if (values[key] !== undefined) {
      return values[key];
    }
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : undefined;
}

function normalizeRestartMode(value: string | undefined): RestartMode {
  if (!value?.trim()) {
    throw new Error("Restart mode is required. Use manual or automatic.");
  }
  const normalized = value.toLowerCase();
  if (normalized === "manual" || normalized === "automatic") {
    return normalized;
  }
  throw new Error(`Unknown restart mode "${value}". Use manual or automatic.`);
}

function normalizePercent(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be a number from 0 to 100.`);
  }
  return Math.round(value);
}

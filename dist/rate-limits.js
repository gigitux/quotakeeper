export function normalizeRateLimits(response, limitIds = ["codex"]) {
    const allBuckets = response.rateLimitsByLimitId && Object.keys(response.rateLimitsByLimitId).length
        ? Object.entries(response.rateLimitsByLimitId)
        : [[response.rateLimits.limitId ?? "default", response.rateLimits]];
    const selected = allBuckets.filter(([limitId]) => limitIds.includes(limitId));
    const buckets = selected.length ? selected : allBuckets;
    return buckets.map(([fallbackId, snapshot]) => normalizeSnapshot(fallbackId, snapshot));
}
export function evaluateGuard(rateLimits, policy, goal) {
    const hardestReason = hardStopReason(rateLimits);
    const nextEvaluationAt = nextResetIso(rateLimits);
    if (goal?.status === "budgetLimited" || goal?.status === "usageLimited") {
        return {
            status: "pause_required",
            reason: "goal_budget_limited",
            goal,
            policy,
            rateLimits,
            nextEvaluationAt,
        };
    }
    if (goal?.status === "paused") {
        const status = isRestartAvailable(rateLimits, policy) ? "restart_available" : "paused";
        return {
            status,
            reason: status === "restart_available" ? "threshold_reached" : "unknown",
            goal,
            policy,
            rateLimits,
            nextEvaluationAt,
        };
    }
    if (hardestReason) {
        return {
            status: "pause_required",
            reason: hardestReason,
            goal,
            policy,
            rateLimits,
            nextEvaluationAt,
        };
    }
    const usageLimitStatus = evaluateUsageLimits(rateLimits, policy);
    if (usageLimitStatus === "pause_required") {
        return {
            status: "pause_required",
            reason: "threshold_reached",
            goal,
            policy,
            rateLimits,
            nextEvaluationAt,
        };
    }
    if (usageLimitStatus === "warning") {
        return {
            status: "warning",
            reason: "threshold_reached",
            goal,
            policy,
            rateLimits,
            nextEvaluationAt,
        };
    }
    return {
        status: "healthy",
        reason: "unknown",
        goal,
        policy,
        rateLimits,
        nextEvaluationAt,
    };
}
export function isHardStop(reason) {
    return (reason === "rate_limit_reached" ||
        reason === "credits_depleted" ||
        reason === "goal_budget_limited");
}
function normalizeSnapshot(fallbackId, snapshot) {
    const windows = [snapshot.primary, snapshot.secondary].filter(Boolean);
    const usedFromWindows = windows.map((window) => window.usedPercent);
    const individualUsed = snapshot.individualLimit
        ? 100 - snapshot.individualLimit.remainingPercent
        : undefined;
    const usedPercent = Math.max(0, ...usedFromWindows, individualUsed ?? 0);
    const resetCandidates = [
        ...windows.map((window) => window.resetsAt),
        snapshot.individualLimit?.resetsAt,
    ].filter((value) => typeof value === "number");
    const durationCandidates = windows
        .map((window) => window.windowDurationMins)
        .filter((value) => typeof value === "number");
    return {
        limitId: snapshot.limitId ?? fallbackId,
        limitName: snapshot.limitName,
        planType: snapshot.planType,
        usedPercent,
        remainingPercent: Math.max(0, 100 - usedPercent),
        resetsAt: resetCandidates.length ? Math.min(...resetCandidates) : null,
        windowDurationMins: durationCandidates.length ? Math.min(...durationCandidates) : null,
        primary: snapshot.primary,
        secondary: snapshot.secondary,
        credits: snapshot.credits,
        rateLimitReachedType: snapshot.rateLimitReachedType,
    };
}
function evaluateUsageLimits(rateLimits, policy) {
    const usageWindows = usageLimitWindows(rateLimits, policy);
    if (!usageWindows.length) {
        return "healthy";
    }
    if (usageWindows.some(({ usedPercent, limitPercent }) => usedPercent >= limitPercent)) {
        return "pause_required";
    }
    if (usageWindows.some(({ usedPercent, limitPercent }) => usedPercent >= Math.max(0, limitPercent - 5))) {
        return "warning";
    }
    return "healthy";
}
function isRestartAvailable(rateLimits, policy) {
    return usageLimitWindows(rateLimits, policy).every(({ usedPercent, limitPercent }) => usedPercent < limitPercent);
}
function usageLimitWindows(rateLimits, policy) {
    const usageLimits = policy.usageLimits;
    return rateLimits.flatMap((rateLimit) => {
        const windows = [];
        const fiveHourWindow = findFiveHourWindow(rateLimit);
        const weeklyWindow = findWeeklyWindow(rateLimit, fiveHourWindow);
        if (usageLimits.fiveHourUsagePercent > 0 && fiveHourWindow) {
            windows.push({
                usedPercent: fiveHourWindow.usedPercent,
                limitPercent: usageLimits.fiveHourUsagePercent,
            });
        }
        if (usageLimits.weeklyUsagePercent > 0 && weeklyWindow) {
            windows.push({
                usedPercent: weeklyWindow.usedPercent,
                limitPercent: usageLimits.weeklyUsagePercent,
            });
        }
        return windows;
    });
}
function findFiveHourWindow(rateLimit) {
    const windows = [rateLimit.primary, rateLimit.secondary].filter(Boolean);
    const explicit = windows.find((window) => window.windowDurationMins === 300);
    return explicit ?? rateLimit.primary ?? windows[0] ?? fallbackWindow(rateLimit);
}
function findWeeklyWindow(rateLimit, fiveHourWindow) {
    const windows = [rateLimit.primary, rateLimit.secondary].filter(Boolean);
    const explicit = windows.find((window) => window.windowDurationMins === 10080);
    return explicit ?? windows.find((window) => window !== fiveHourWindow) ?? null;
}
function fallbackWindow(rateLimit) {
    return {
        usedPercent: rateLimit.usedPercent,
        resetsAt: rateLimit.resetsAt,
        windowDurationMins: rateLimit.windowDurationMins,
    };
}
function hardStopReason(rateLimits) {
    for (const limit of rateLimits) {
        if (limit.credits && !limit.credits.unlimited && !limit.credits.hasCredits) {
            return "credits_depleted";
        }
        if (limit.rateLimitReachedType?.includes("credits_depleted") ||
            limit.rateLimitReachedType?.includes("usage_limit_reached")) {
            return "credits_depleted";
        }
        if (limit.rateLimitReachedType === "rate_limit_reached") {
            return "rate_limit_reached";
        }
    }
    return null;
}
function nextResetIso(rateLimits) {
    const resets = rateLimits
        .map((limit) => limit.resetsAt)
        .filter((value) => typeof value === "number");
    if (!resets.length) {
        return null;
    }
    return new Date(Math.min(...resets) * 1000).toISOString();
}
//# sourceMappingURL=rate-limits.js.map
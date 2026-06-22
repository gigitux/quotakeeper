---
name: quota-goal-supervisor
description: Supervise long-running Codex Goals with QuotaKeeper so they do not consume the user's subscription quota, based on Codex rate-limit usage rather than token-context usage. Use when a Goal should ask for an explicit per-Goal usage percentage policy and manual/automatic restart choice, monitor Codex rate-limit capacity, checkpoint progress, pause before quota exhaustion, block while waiting for required policy answers, or restart after capacity returns.
---

# Quota Goal Supervisor

Use QuotaKeeper to supervise a long-running Codex Goal against the user's quota policy.

QuotaKeeper is about Codex quota/rate-limit usage windows. Do not treat token context, context-window size, `tokensUsed`, or a Goal token budget as the usage percentage.

## Workflow

1. Confirm there is an active Codex Goal and identify its `threadId`.
2. Before monitoring, run `scripts/quota-keeper.js configure-goal --thread-id <threadId>` so the Goal has an explicit quota policy.
3. For a one-time decision, run `scripts/quota-keeper.js check-status --thread-id <threadId>`.
4. For an in-thread Desktop/App check, run `scripts/quota-keeper.js monitor --thread-id <threadId> --once`.
5. Use long-running `monitor` only from an external terminal or automation where a persistent process is expected.
6. If the script reports `pause_required`, summarize current progress and run `pause-goal` with that summary.
7. If the script reports `restart_available`, restart only when the saved policy has `restartMode: "automatic"` or the user explicitly asks to resume.
8. If the required policy answers are missing because the user has not replied, mark the active Goal as blocked with the native Goal-control tool when that tool is available. Do not keep asking the same configuration questions in automatic continuation turns.

## Policy

Configure per Goal. If the Codex project root being supervised contains a `.goalkeeper` file, `configure-goal` reads the explicit policy from that file without asking questions. Otherwise it must ask the user three questions:

- 5-hour usage limit percent.
- Weekly usage limit percent.
- Restart mode: `manual` or `automatic`.

Do not infer, default, or choose these answers for the user. Do not start monitoring, resume the Goal, or continue the Goal workflow until all three answers are provided by the user or by `.goalkeeper`. Blank answers are not accepted. For the usage-limit questions, `0` means unlimited for that window and must be answered explicitly.

If there is no `.goalkeeper` file and the user does not provide all three answers in the current turn, tell the user exactly which answers are needed, then block the active Goal and stop. When a native Goal-control tool such as `update_goal` is available, use it directly with blocked status; this is the preferred in-thread path because it stops the current Goal instead of spawning a helper that may interrupt its own turn. Use `scripts/quota-keeper.js block-unconfigured-goal --thread-id <threadId> --summary "Waiting for explicit QuotaKeeper policy answers."` only from external automation or when no native Goal-control tool is available.

`.goalkeeper` may be JSON:

```json
{
  "fiveHourUsagePercent": 80,
  "weeklyUsagePercent": 90,
  "restartMode": "manual"
}
```

or key-value lines:

```text
fiveHourUsagePercent=80
weeklyUsagePercent=90
restartMode=manual
```

The `.goalkeeper` file must include `fiveHourUsagePercent`, `weeklyUsagePercent`, and `restartMode`.

## Commands

```bash
scripts/quota-keeper.js configure-goal --thread-id <threadId>
scripts/quota-keeper.js block-unconfigured-goal --thread-id <threadId> --summary "Waiting for explicit QuotaKeeper policy answers."
scripts/quota-keeper.js check-status --thread-id <threadId>
scripts/quota-keeper.js create-checkpoint --thread-id <threadId> --reason threshold_reached --summary "Progress summary"
scripts/quota-keeper.js pause-goal --thread-id <threadId> --reason threshold_reached --summary "Progress summary"
scripts/quota-keeper.js resume-goal --thread-id <threadId>
scripts/quota-keeper.js monitor --thread-id <threadId> --once
```

`pause-goal` sets the Goal to paused and interrupts the active turn when App Server exposes an in-progress turn. This is required because setting Goal metadata alone may not stop an already-running Desktop turn.

Use `--force` with `resume-goal` only when the user explicitly asks to resume despite manual restart mode.

## Storage

- Per-Goal policy: `.quota-keeper/goals/<threadId>/policy.json`
- Checkpoints: `.quota-keeper/checkpoints/<threadId>/checkpoint-<timestamp>.json`

## App Server

Use Codex App Server v2 methods documented in `references/app-server-v2.md`.

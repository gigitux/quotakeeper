# QuotaKeeper

QuotaKeeper protects long-running Codex Goals from exhausting your Codex quota.

It configures a per-Goal quota policy, monitors the account rate-limit windows exposed by the Codex App Server, creates checkpoints when a pause is needed, pauses the active Goal, and can restart the Goal later when capacity is available.

## When To Use It

Use QuotaKeeper when a Codex Goal may run for a long time and you want it to stop before it consumes too much of your quota.

Good fits:

- Long-running implementation Goals.
- Batch cleanup or migration Goals.
- Investigation Goals that may take many turns.
- Any Goal where you want a predictable 5-hour or weekly usage ceiling.

QuotaKeeper is designed for Codex Goals. Start a Goal first, then configure QuotaKeeper for that Goal.

## Quick Start

1. Create or identify an active Codex Goal.
2. Get the Goal's `threadId`.
3. Configure the Goal policy:

```bash
scripts/quota-keeper.js configure-goal --thread-id <threadId>
```

4. Check the current status once:

```bash
scripts/quota-keeper.js check-status --thread-id <threadId>
```

5. For in-thread Desktop/App supervision, run one monitor pass:

```bash
scripts/quota-keeper.js monitor --thread-id <threadId> --once
```

If `monitor --once` returns `pause_required`, summarize the current progress and pause the Goal:

```bash
scripts/quota-keeper.js pause-goal --thread-id <threadId> --reason threshold_reached --summary "Progress so far..."
```

For persistent supervision from an external terminal or automation, run:

```bash
scripts/quota-keeper.js monitor --thread-id <threadId>
```

## Policy Configuration

QuotaKeeper configures each Goal separately.

Put `.goalkeeper` in the project where Codex is doing the work, not in this plugin repository. QuotaKeeper reads it from the configured project root: the current working directory by default, or the path passed with `--cwd`.

If that project root contains a `.goalkeeper` file, `configure-goal` reads limits from that file and does not ask questions. If there is no `.goalkeeper` file, it asks three questions:

- 5-hour usage limit percent.
- Weekly usage limit percent.
- Restart mode: `manual` or `automatic`.

QuotaKeeper will not configure, monitor, resume, or continue the Goal workflow until all three answers are provided. Blank answers are not accepted. For the usage-limit questions, `0` means unlimited for that window and must be answered explicitly.

### JSON Dotfile

```json
{
  "fiveHourUsagePercent": 80,
  "weeklyUsagePercent": 90,
  "restartMode": "manual"
}
```

### Key-Value Dotfile

```text
fiveHourUsagePercent=80
weeklyUsagePercent=90
restartMode=manual
```

Required fields:

- `fiveHourUsagePercent`
- `weeklyUsagePercent`
- `restartMode`

Optional fields:

- `limitIds`: comma-separated rate-limit bucket ids. Defaults to `codex`.

## What Happens When A Limit Is Reached

QuotaKeeper evaluates the configured 5-hour and weekly windows independently.

- If an enabled window reaches its configured percentage, status becomes `pause_required`.
- If a window is within 5 percentage points of its limit, status becomes `warning`.
- If a window limit is `0`, QuotaKeeper ignores that window.
- Hard account stops, such as depleted credits or an already reached rate limit, always cause `pause_required`.

When `pause-goal` runs, QuotaKeeper:

1. Creates a checkpoint in `.quota-keeper/checkpoints/<threadId>/`.
2. Sets the Goal status to `paused`.
3. Interrupts the active turn when the Codex App Server exposes one.

## Restart Behavior

Use `resume-goal` to continue from the latest checkpoint:

```bash
scripts/quota-keeper.js resume-goal --thread-id <threadId>
```

If the saved policy has `restartMode: "manual"`, QuotaKeeper reports that restart is available but does not start a new turn automatically.

To resume despite manual mode:

```bash
scripts/quota-keeper.js resume-goal --thread-id <threadId> --force
```

If the saved policy has `restartMode: "automatic"`, `monitor --once` and persistent `monitor` may restart the Goal when quota is available again.

## Command Reference

```bash
scripts/quota-keeper.js configure-goal --thread-id <threadId>
scripts/quota-keeper.js check-status --thread-id <threadId>
scripts/quota-keeper.js monitor --thread-id <threadId> --once
scripts/quota-keeper.js monitor --thread-id <threadId>
scripts/quota-keeper.js create-checkpoint --thread-id <threadId> --reason threshold_reached --summary "Progress summary"
scripts/quota-keeper.js pause-goal --thread-id <threadId> --reason threshold_reached --summary "Progress summary"
scripts/quota-keeper.js resume-goal --thread-id <threadId>
```

Useful flags:

- `--cwd <path>`: read and write policy/checkpoint files in another project root.
- `--turn-id <turnId>`: provide the active turn id explicitly.
- `--five-hour-usage <percent>`: configure the 5-hour limit without prompting.
- `--weekly-usage <percent>`: configure the weekly limit without prompting.
- `--restart manual|automatic`: set restart behavior.
- `--limit-ids codex,other`: choose rate-limit buckets.
- `--poll-interval <seconds>`: set the persistent monitor interval. Defaults to 60 seconds.
- `--force`: allow `resume-goal` to restart even when the policy is manual.

When there is no `.goalkeeper` file and `configure-goal` is run non-interactively, provide `--five-hour-usage`, `--weekly-usage`, and `--restart`; otherwise configuration fails and monitoring will not start.

## Stored Files

QuotaKeeper writes runtime state into the current project root:

```text
.quota-keeper/
  goals/<threadId>/policy.json
  checkpoints/<threadId>/checkpoint-<timestamp>.json
```

Commit `.goalkeeper` if you want a shared project policy. Do not commit `.quota-keeper/` runtime state unless you intentionally want to share local Goal policies and checkpoints.

## Development

Install dependencies:

```bash
pnpm install
```

Build the CLI:

```bash
pnpm run build
```

Run checks:

```bash
pnpm run test
pnpm run lint
pnpm run validate:skill
pnpm run validate:plugin
```

`scripts/quota-keeper.js` imports the compiled CLI from `dist/cli.js`, so run `pnpm run build` after changing TypeScript sources.

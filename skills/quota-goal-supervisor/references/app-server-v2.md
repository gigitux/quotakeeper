# Codex App Server v2 Methods

QuotaKeeper targets the App Server schema generated from local `codex-cli 0.141.0`.

Required request methods:

- `account/rateLimits/read`: read current account rate-limit buckets.
- `thread/goal/get`: read the current Goal for a thread.
- `thread/goal/set`: set Goal status to `paused` or `active`.
- `thread/read`: read thread turns with `includeTurns: true` so QuotaKeeper can find the active turn id before pausing.
- `turn/interrupt`: interrupt an active turn after hard quota exhaustion.
- `turn/start`: start the continuation turn after an automatic restart.

Relevant notifications:

- `account/rateLimits/updated`: sparse rate-limit updates.
- `thread/goal/updated`: Goal status changes.
- `turn/started`: active turn tracking.
- `turn/completed`: turn completion tracking.

Rate-limit fields used:

- `rateLimitsByLimitId`: preferred multi-bucket map. Use `codex` when present.
- `rateLimits`: fallback single-bucket view.
- `primary.usedPercent` and `secondary.usedPercent`: window usage.
- `individualLimit.remainingPercent`: spend-control remaining capacity.
- `credits.hasCredits` and `credits.unlimited`: credit availability.
- `rateLimitReachedType`: hard-stop reason when set.

---
name: command-code-usage
description: Check how much of a Command Code plan is left. Reads the 5-hour, weekly and monthly quota windows - remaining amount, percentage and reset time - from the Command Code API, using the credential already on the machine. Use it when the user asks how much quota is left, whether the plan can finish a task, or when they hit a limit.
---

# Command Code Usage

Command Code reports quota per rolling window, but only on the web dashboard and in the
CLI's own screens. This skill answers the questions a user actually asks mid-work - *how
much is left, and does it last until the reset* - without them leaving the editor.

Everything runs locally: one script, no dependencies, no telemetry. Checking the quota
does not consume any.

## When to Use This Skill

- "How much of my Command Code plan is left?"
- "Can I finish this refactor on the current 5-hour window?"
- "When does my usage reset?"
- "Did that big run eat the month?" / "Am I going to run out before Friday?"
- The user just hit a rate limit or quota error and wants to know how long it lasts.

Do not use it to change anything about the plan - it only reads.

## Prerequisites

- **Node 18+** (the script uses the built-in `fetch`).
- **A Command Code credential.** In order of lookup:
  1. `COMMAND_CODE_API_KEY`, `COMMANDCODE_API_KEY` or `CMD_API_KEY` in the environment.
  2. `~/.commandcode/auth.json`, written when the user signs in with the Command Code CLI.

  If neither exists, the script exits with code 2 and says so - then ask the user to sign
  in with the Command Code CLI rather than asking them to paste a key into the chat. If
  their key lives inside a host's provider config instead (for example
  `~/.zcode/v2/provider_config.json`), it can be passed as `COMMAND_CODE_API_KEY` for one
  call; never echo the value back.

## How to Use

Run the script and show its output as it is printed:

```bash
node scripts/cc-usage.mjs
```

```
GOAT / alex
  5h    ▌░░░░░░░░░   5%  $13.32 left of $14.00          resets 09-22 04:16 (in 3h35m)
  week  ███▊░░░░░░  37%  $22.00 left of $35.00          resets 09-27 23:29 (in 5d22h)
  month █▉░░░░░░░░  19%  $57.00 left of $70.00          resets 10-20 23:25 (in 28d22h)
  period 2891 requests / $10.22 spent / avg $0.0035 each
         the month has room for about 16120 more at that price
```

Do not recompute the numbers or redraw the bars - the script already normalized the API's
raw fields, and a second pass is how the answer drifts. To answer a follow-up, quote the
row it came from.

For anything programmatic - a badge, a summary line, a comparison over time - use the JSON:

```bash
node scripts/cc-usage.mjs --json
```

```json
{
  "plan": "GOAT",
  "status": "active",
  "limited": true,
  "windows": {
    "fiveHour": { "used": 0.67, "cap": 14, "percent": 4.8, "remaining": 13.32, "resetAt": 1790021805875, "resetsInMs": 12937376, "exceeded": false },
    "weekly": { "used": 12.99, "cap": 35, "percent": 37.1, "remaining": 22.0, "resetAt": 1790436566000, "resetsInMs": 503376000 }
  },
  "monthly": { "used": 12.99, "cap": 70, "remaining": 57.0, "percent": 18.6, "resetAt": 1792548325000, "resetsInMs": 2490000000 },
  "spend": { "total": 10.22, "perRequest": 0.0035, "requests": 2891, "failed": 0, "successRate": 100 }
}
```

## Reading the Numbers

The unit is **US dollars of plan value**, not requests. A window's `cap` is what the plan
allows and `used` is what has been spent against it; one expensive model can consume a
window that a cheap one barely touches. Never translate to "messages" unless the script
already did, and then say the price it used.

- `percent` is clamped to 100. If a window reports `exceeded: true`, say so - the plan is
  over its limit and requests may be refused or billed differently.
- `resetAt` and `currentPeriodEnd` are epoch milliseconds. Always convert to the user's
  local time; a raw timestamp is not an answer.
- `resetsInMs` is the countdown, and it is what "will it last?" hinges on. A window at 40%
  with four hours left is comfortable; the same 40% with twenty minutes left is not.
- `limited: false` means the account has no rolling windows at all. `windows.fiveHour` and
  `windows.weekly` are then `null`, and the monthly pool is the whole story. Do not report
  that as missing data.
- `monthly.cap` is the plan's face value while the subscription is active, otherwise what
  has been spent plus what is left. `spend.*` describes the current billing period and is a
  different question from the quota windows - do not add the two together.
- `spend.perRequest` is the average price of a request **in this period** (around
  `$0.0035`). It is an average over whatever model mix the user has been running, so any
  request count derived from it is an estimate - say "about", and name the price it came
  from. Switching to a more expensive model makes the real number smaller.

## Going Beyond the Script

The script covers the usual questions. If you need a field it does not expose, these are
the endpoints behind it (all `GET`, all with `Authorization: Bearer <credential>`):

| Endpoint | What it returns |
|---|---|
| `/alpha/whoami?limits=1` | the account, the org, and the org's limits |
| `/alpha/billing/credits?orgId=` | `credits` (`monthlyCredits`, `purchasedCredits`, `freeCredits`) and `windowLimits` (`limited`, `fiveHour`, `weekly`, each `{used, cap, resetAt, exceeded}`) |
| `/alpha/billing/subscriptions?orgId=` | `data` with `planId`, `status`, `currentPeriodStart`, `currentPeriodEnd` |
| `/alpha/usage/summary?since=` | `totalCount`, `totalCost`, `averageCost`, `successRate`, token totals for the period |

Base URL `https://api.commandcode.ai`, overridable with `COMMAND_CODE_API_BASE`. For a team
account, pass `?orgId=` to the billing and usage calls; `/alpha/whoami` gives the id.

## Plans

The window sizes per plan, used only when the API does not report a `cap`:

| Plan (`planId`) | Month | 5 hours | Week |
|---|---|---|---|
| `individual-go` | $10 | $3 | $6 |
| `individual-goat` | $70 | $14 | $35 |
| `individual-pro` | $80 | $16 | $40 |
| `individual-max-10x` | $150 | $45 | $90 |
| `individual-max-20x` | $300 | $90 | $180 |
| `teams-pro` | $40 | $12 | $24 |

An account on something not listed here still works: the API's own `cap` values win, and
the table is only a fallback. If a user's plan reports no `cap` and no table entry, report
what was actually used instead of guessing a denominator.

## Troubleshooting

| What you see | What it means |
|---|---|
| exit code 2, "No Command Code credential found" | Neither the environment variable nor `~/.commandcode/auth.json` exists. Ask the user to sign in with the Command Code CLI. |
| exit code 1, `HTTP 401` / `HTTP 403` | The credential was rejected - it is stale or from a different account. Signing in again with the CLI rewrites `auth.json`. |
| exit code 1, `HTTP 429` | The API rate-limited this machine. Wait a minute, then retry once - a run makes four calls. |
| `5h  not applicable on this plan` | `windowLimits.limited` is `false`. Expected, not a failure. |
| `note: /alpha/... -> HTTP 500` | One endpoint failed and the rest still answered. Report the rows you have and mention the failing endpoint; do not retry more than once. |
| All four endpoints fail | The script exits 1 with the list. Usually a network problem or a wrong `COMMAND_CODE_API_BASE`. |

The script only reads. It writes no files, sends nothing anywhere except the API, and exits
non-zero rather than printing a partial answer it cannot vouch for.

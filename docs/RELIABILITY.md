# Reliability evidence protocol

This is **unreleased evaluation tooling**, separate from the measured historical versions and the `v0.1.0-alpha.1` release asset. It does not establish general reliability or savings.

## What the new suite measures

Ten new change tasks span three dependency-free fixture projects: `queue-kit` (4), `cache-kit` (3), and `config-kit` (3). These are controlled miniature projects, **not ten tasks collected from three real-world repositories**. Contracts, checks, reference implementations, and mutants are public in `benchmark/reliability/cases.json`; this is not a blinded holdout. Do not train or tune on these cases and then describe them as unseen tasks.

The schedule has three repetitions of each task for Smart and Deep-only: 60 isolated executions. Arm order alternates by task and repetition. Both arms receive identical fixture bytes, per-run limits, validation commands, and acceptance criteria. Each execution gets a new project and native session. Repetitions of a task are correlated; 60 slots do not represent 60 independent tasks. The suite currently covers small implementation changes only, not broad architecture work, read-only response quality, or real repository integrations.

Acceptance requires all of:

1. Controller status `completed`.
2. Harness-owned behavioral checks pass in a separate temporary evaluation directory, including input preservation.
3. Pre-existing protected fixture files are byte-identical.

The model-visible test contains only the first example. The full judge is outside its workspace, but public in this repository; this reduces accidental test editing, not adversarial access. Reference and baseline self-checks verify that each judge accepts a correct implementation and rejects both a broken baseline and a behavioral mutant. The self-check is **harness validation**, not router performance.

A blocked/cancelled/unverified run never counts as an accepted completion even if its code passes. `completedButRejected` identifies completed workflows whose behavioral checks or protected-file checks failed. It is not a count of every possible false claim or unauthorized action. Permission denials are reported separately; a denied attempt does not prove an unauthorized operation executed. A blocked budget is a control outcome, not a delivered task.

## Offline checks — no key or inference

From a source checkout:

```sh
npm ci
npm run reliability
npm run reliability -- --verify-fixtures
npm run test:reliability
```

Preview does not load `.env` or personal model configuration. Ordinary tests use a dummy credential and loopback HTTP only. Failure injection covers HTTP 429/503, HTTP 400, incomplete JSON, timeout, unavailable receipts, prose claiming success, an authenticated local guard denial, active cancellation, inspection without replay, and a zero preflight budget. Production controller/meter code is exercised through a scripted transport shim; native OpenCode permissions/tools remain covered by the existing native smokes. This is not evidence of real-model behavior.

## Rehearse the complete campaign — still no inference

```sh
npm run reliability -- --freeze \
  --config benchmark/reliability/rehearsal.config.json \
  --budget 1 --per-run-budget 0.05 \
  --output artifacts/reliability-rehearsal-plan.json
```

Copy `planSha256` from that command's output, then:

```sh
npm run reliability -- --rehearse \
  --plan artifacts/reliability-rehearsal-plan.json \
  --plan-sha256 <PLAN_SHA256> \
  --output artifacts/reliability-rehearsal
```

Rehearsal uses scripted reference solutions and real local test subprocesses. Its summary is explicitly marked `SIMULATION`. Sixty accepted simulated completions validate scheduling, orchestration, evaluation, and reporting; they do **not** measure router/model quality. A rehearsal can run even with an invalid provider key because it never starts a provider or reads `.env`.

Freeze plans only after building the final source. Plans bind the source/runtime hash, package lock when available, Node/platform/architecture, suite bytes, models, controller limits, global/per-run budgets, timeout, schedule, and fixture hashes. Keep the printed plan hash separately before starting; the runner checks it as well as current source and fixtures. The plan records the Git commit and dirty state when available; the content hash binds uncommitted runnable changes. Plans produced by the source TypeScript entry point and compiled entry point have different runtime fingerprints; use the same invocation method. Never replace a frozen plan to repair an ongoing series.

## Later paid campaign — separate spending authorization

This implementation has **not** run a new paid campaign. Obtain an explicit budget and run in a disposable environment. Both the model-visible validation and the independent evaluator execute candidate code. Permission whitelists are not an OS sandbox. Do not run generated code next to credentials, personal files, or confidential repositories.

Create an explicit configuration using available real `openrouter/vendor/model` IDs and the full configuration schema. Freeze it with the desired global `--budget` and `--per-run-budget` using the command above. Placeholders are rejected. No credentials belong in that configuration or plan. The next command incurs charges:

```sh
npm run reliability -- --run --allow-fixture-tools \
  --plan artifacts/paid-plan.json --plan-sha256 <PLAN_SHA256> \
  --output artifacts/paid-campaign
```

Only `--run` reads the current directory's `.env` or existing `OPENROUTER_API_KEY`. The explicit fixture permission permits edits to `index.mjs` and exactly `npm test`; no automatic arbitrary write, shell, or external-directory approval is added. The general CLI's between-request budget remains a **soft limit**, not an invoice cap. A new slot starts only if the remaining global budget can fund the full frozen per-run cap; the second arm never receives a silently reduced cap. Unknown cost stops the series. The timeout requests cooperative cancellation; it is not a hard wall-clock kill.

## Evidence and reporting

The output directory must be new. The runner writes an exclusive `.started.json` before a slot, a private `.task.json` with operational evidence, and an exclusive `.result.json`. `summary.json` is a regenerable local summary. A process crash can leave a started slot without a result; inspect provider/native evidence and reconcile its cost before any new campaign. The runner deliberately cannot resume or silently replay that slot. Do not replace a failed attempt with its retry. Preserve original files if you repair or extend a series.

The summary separates planned, attempted, pending, accepted-completed, completed-but-rejected, blocked, failed, unverified, harness errors, cancelled, permission-denial attempts, known spend, unknown spend, maximum duration, and matched pairs. Failed and unmatched attempts contribute to total known spend. Cost per accepted completion is absent if that arm has unknown cost or no accepted completions. It includes all attempted spend in the arm, not just successful rows. Do not compare arm averages as paired evidence when slots are incomplete. Pending slots are neither successes nor failures.

Reports belong in ignored `artifacts/` or a private temporary directory. Task evidence may contain native IDs and paths; **do not upload raw task files**. Even the reduced summary needs manual sanitization of model IDs/notes and an explicit simulation/paid label before publication. Publish the frozen plan hash, exact source version, suite hash, models, limits, all outcomes, total cost, unknowns, and stop reason. Do not pool this series with historical results. This CLI does not compute population confidence intervals; repeated fixture tasks do not justify an independent-binomial reliability estimate.

## Next evidence gate: real repositories

Use [the prospective case template](../benchmark/reliability/EXTERNAL-CASE-TEMPLATE.md) to register genuinely new tasks from at least three independently maintained repositories. Freeze their clean commits, task criteria, permissions, project commands, and independent regression checks before execution. Confirm license/consent and sanitize confidential data before sharing fixtures. Include setup failures and withdrawals in the report. Keep acceptance by executable tests distinct from AI technical review; the latter is not blinded human review.

For each case, require a failing baseline and a passing reference, and verify that a plausible broken patch fails the independent checks. Run both arms from identical snapshots. Improvements after inspecting failures get a new evaluation version and new cases; retain the earlier failures. Ask external users to reproduce the quickstart and selected tasks without maintainer configuration. Publish the bounded claim “X/Y tasks completed under these conditions,” not a universal reliability percentage.

# Evaluation and limitations

## Reproduce the procedure

`npm run benchmark` previews the 20 synthetic cases without credentials or inference. The mix is 5 trivial, 7 usual, 5 complex, and 3 sensitive tasks. Smart and Deep-only start from identical fixtures with equivalent checks.

A real evaluation is explicitly paid:

```sh
npm run benchmark -- --run --budget 1 --output artifacts/my-benchmark.json --allow-fixture-tools
```

First configure models, the API key, and a budget at least as large as the selected --budget. --allow-fixture-tools authorizes only the fixture solution file and exact npm test command; it also runs generated code through the independent evaluator. Use disposable environments. Without that flag each operation requires interactive approval. This runner is not an OS sandbox and the general budget is checked between requests, not a hard invoice cap.

Reports are created exclusively rather than overwriting prior runs. Preserve failures, unmatched/censored runs, and every paid attempt. Backend-reported costs and provider receipts are distinct; unavailable receipts remain unknown.

## Historical findings

The [sanitized historical summary](../benchmark/historical-summary.json) publishes selected row-level fields only. Original transcripts, receipts, account totals, local paths, and frozen private workspaces are not distributed. Historical source versions differ from this alpha; the current runner reproduces the procedure, not the exact historical model outputs or patched-code scores.

- Synthetic v2: 20 pairs / 40 real-model executions. Primary tests passed in 20 Smart and 19 Deep-only runs. Codex technical review accepted 16 and 17 implementations; including completed workflow and sensitive-routing conformity, 15 and 17. The observed ratio 15/17 is about 88.24%, below the initial 90% quality hypothesis. Primary tests alone overstated quality. Series cost: $5.716350427, including interrupted rows.
- Four-task real pilot: Smart had 2/4 and Deep 3/4 accepted deliveries with a completed workflow under final review. The corrected series cost $2.445445657; four earlier invalid-harness diagnostic trials cost $0.490859115 and are additional spend, not successful task completions.
- Two-task expansion: both arms completed 1/2 workflows. Core technical content was accepted for both tasks in each arm; Deep's read answer exceeded the requested length and was truncated. Both editing flows hit exact-command permission denials.
- Targeted post-fix UTM pair: both arms executed the three exact validation commands and their tests passed independent checks and code review. Smart completed; Deep was stopped by a conservative local budget reservation. Its historical infrastructure label was later corrected in the controller; the original blocked result remains preserved.

The benchmark review was performed by Codex after the owner waived human review. It is not a blinded independent evaluation. Post-hoc edge checks, changed core versions, model behavior, run order, and operational caps limit comparisons. Do not pool the different series or generalize a single repeated task.

These experiments do **not** establish quality equivalence or savings with comparable quality. The alpha exposes a testable routing mechanism, not a validated economic advantage. New results should identify their exact commit, model IDs, criteria, all costs, and any censoring separately.

## Prospective reliability suite

The [reliability protocol](RELIABILITY.md) defines a separate ten-task controlled suite, frozen 60-slot schedule, offline rehearsal and failure injection. Its reference solutions are public and its projects are fixtures. Self-checks and simulations do not extend the historical paid evidence or establish reliability on real repositories.

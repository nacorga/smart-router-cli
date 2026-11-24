# Security and privacy

This experimental alpha runs coding tools on your machine. It relies on OpenCode permissions and your approval; it is not an OS sandbox.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/nacorga/smart-router-cli/security/advisories/new). Do not put credentials, exploit details, or confidential code in a public issue. Include the version, platform, affected behavior, and a minimal sanitized reproduction. Only the latest alpha is currently supported; no response-time guarantee is offered.

## Data flow

Real tasks send prompts and relevant code to the configured model provider. This alpha initially integrates OpenRouter, which may route to downstream providers. Review their data policies before using confidential code. There is no hidden usage telemetry.

Only OPENROUTER_API_KEY is loaded from the project .env file; the shell takes precedence. Task metadata lives under SMART_STATE_DIR, or $XDG_STATE_HOME/smart-router, or ~/.local/state/smart-router. It contains usage, decisions, checkpoints, and references; Smart Router does not add copies of prompts or file contents there. OpenCode keeps separate native history which can contain those contents. Terminal output may also contain code.

The benchmark runner deliberately retains generated solutions and usage for evaluation. Its output is local, sensitive experiment data and must be reviewed before sharing.

## Operational boundaries

- Every write or shell command requests approval. Without an interactive terminal, approval is denied.
- Read-only stages deny shell and edits; common secret paths, external-directory access, and child-agent tools are blocked by native rules.
- Recognized destructive commands, Git mutations, deployments, and credential references are refused by the adapter. Pattern checks cannot prove the safety of every possible command.
- Existing edits are detected and the agent is instructed to preserve them. Always inspect the actual diff.
- Locks coordinate Smart Router writers on the same Git root. They do not coordinate unrelated tools. After a crash, inspect native sessions before manually removing a stale lock.
- Cancel stops future stages and requests abort. It does not undo earlier effects. Resume inspects state without replay; continuing requires a new explicit request.
- Budget checks in the CLI run between requests, not every provider token. The text-only benchmark relay has additional conservative reservations; it is not a universal CLI spending guarantee.
- Unknown costs remain unknown. A proven local pre-provider denial has zero incremental provider cost and is classified as a local limit, not a model implementation failure.

Use a disposable checkout for initial experiments and configure provider-side spending limits.

## Factory orchestration

Factory TaskSpecs cannot grant tool or publication permissions. Independent checks
and commit/push/Draft PR each require explicit host approval; noninteractive use
denies them. Factory worktrees and filtered validation environments are not an OS
sandbox. Approve checks only for trusted local repositories without production
credentials. Private task state includes objectives and operational paths; never
share raw inspection output. Uncertain operations retain inspection guards and are
not automatically replayed. See [Factory boundaries](docs/FACTORY.md).

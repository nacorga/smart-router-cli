# Sequential backend continuity (experimental)

Version 2 configurations opt into an ordered destination chain. Existing configurations continue to use the original OpenCode/OpenRouter controller. Updating the package does not enable subscriptions, failover, background work, or API spending.

## Implementation status

The continuity controller and private handoff store are covered by deterministic local fixtures. The Claude adapter uses a closed Smart MCP tool set and checks its effective native tool list before executing operations. An explicitly authorized real pilot passed on 2026-10-19 for one isolated addition fixture: Codex alone, Claude alone, and a deliberate Codex → Claude handoff between confirmed stages. It preserved the pre-existing file, used one write in the handoff case, and produced independent passing validation. A subsequent authorized lifecycle pilot also passed real Claude → Codex continuity, confirmed-checkpoint recovery through a new CLI process, SIGINT cancellation of running validation children, and TTY permission denial for both backends. Existing uncommitted user changes survived those lifecycle cases. Actual quota exhaustion remains untested.

Codex owns an app-server process with a restricted model catalog, disabled native tools, agents, hooks, apps, plugins and inherited MCP servers. Only Smart's four dynamic tools can act on the project. A smoke with the installed native binary and a deterministic loopback provider verifies the advertised tool registry, rejects unadvertised native operations, executes approved Smart operations, and resumes persisted dynamic tools in a new process. Its preflight checks existing subscription authentication, live model availability, effective configuration and official quota metadata without inference. Missing model metadata or any unverified policy blocks the adapter. Simulated process fixtures complete handoffs in both directions; the real pilots additionally cover both directions on this small fixture.

Protocol baselines: Codex CLI 0.163.0-alpha.10.2 (exact verified binary version), Claude Code 2.1.303. Other versions fail closed until verified. Claude model names must be explicit known coding families (`sonnet`, `haiku`, `opus`, or full `claude-sonnet-*`, `claude-haiku-*`, `claude-opus-*` IDs); the selected family/full ID is checked against the initialization event. The catalog uses a conservative 200k context bound. This is not an account-specific model entitlement check; an unavailable model can still be rejected by the provider.

## Configure and inspect

```sh
smart --init --subscriptions
# Replace each destination's fast/balanced/deep model placeholders.
smart --backends
smart --plan "Implement a parser"
```

The template lists Codex then Claude, with subscription billing. OpenRouter is excluded. A native executable can be selected with a destination's `executable` field; only select a trusted executable. API authentication variables are not inherited by subscription children. Existing sign-in is required; Smart does not extract credentials or perform login automatically.

`limits.maxCostUsd` applies to API destinations. Zero permits subscription work while forbidding API inference. Subscription token usage is recorded without fabricating a monetary charge; fixed subscription prices and extra usage credits are not measured. Disable provider-side paid extra usage separately if you require an included-allowance-only account: Smart cannot enforce account billing settings. A global `maxModelCalls` still bounds wrapper requests across destinations. Each Claude request is also limited to eight native turns; Codex bounds dynamic tool calls and interrupts at eight observed model steps, allowing an already-emitted final answer to reach native turn completion while denying additional tools at the boundary. These are wrapper controls, not a provider-side billing cap. In-flight work can exceed estimates.

Unavailable destinations may be skipped before inference. Quota failover requires a structured, explicit rejection and proof that no tools ran. Unknown quota data is shown as unknown, not estimated. Claude accepts the documented, session-bound `SDKRateLimitEvent` with `status: rejected` and `errorCode: credits_required` as exhaustion of included usage. Generic rejection, HTTP 429, and missing data do not establish exhaustion. Codex accepts `usageLimitExceeded`, while `rateLimitExceeded` remains an infrastructure failure. Tools or uncertain effects block replay even after a quota signal. An exhausted destination is not retried within the same execution. Explicit continuation refreshes availability while retaining all task counters. No polling daemon or automatic waiting is started. Authentication failures, denied permissions, local limits, failing checks, and uncertain transport responses do not authorize failover. Manual model overrides, including `--deep-only`, pin the destination until `/mode auto` revokes them.

## Permissions and evidence

Both adapters execute the same Smart tool policy. Claude runs with native tools disabled, restricted configuration, and only the private Smart MCP server. Before each request, Smart enumerates the official installed-plugin catalog and explicitly disables its entries plus the verified built-in plugins in that process's private settings. Any plugin still advertised at initialization blocks the adapter; the user's normal plugin configuration is not changed. Codex uses dynamic tools backed by this policy and a read-only native sandbox; transport approvals cannot enable other tools. The effective initialization event must advertise only this closed tool set. Smart offers project file reading/listing, approved whole-file writes, and approved direct validation commands. General shell/debugging commands are deliberately unavailable in this adapter. Unknown tools, secrets, symlinks, and paths outside the project are denied. A missing ordinary project file returns a file-not-found tool result, without turning an absent optional instruction file into a permission failure. Read-only stages cannot write or run commands.

Each write shows its content and each command shows its exact invocation before approval. Noninteractive CLI execution denies writes and commands. Approval cannot be granted by a file, model response, or permission-tool call; the executing tool independently checks Smart's policy. Command cancellation terminates its owned POSIX process group. These controls are not an operating-system sandbox for trusted project test scripts or the selected CLI executable.

Actual exit codes provide validation evidence, and a subsequent write invalidates earlier checks. A claimed success never supplies evidence. Subscription records and API charges remain distinct; unknown API costs block new requests.

## Handoffs and recovery

A Git project with a committed base is required. Metadata checkpoints remain separate from private handoff content. The handoff directory uses mode 0700 and files use 0600, under Smart's state directory outside the project. It contains the user objective, constraints, bounded untrusted observations, and references/evidence; it does not copy full transcripts or project files. Native providers retain their own session history separately. Claude cross-process continuation uses the pinned official Agent SDK 0.3.303 metadata API and its CLI active-session listing: the session must belong to the same canonical project and no session may be active there. Missing, foreign or ambiguous session metadata blocks continuation; Smart does not load message history into its handoff.

The fingerprint covers HEAD, index state, tracked worktree content, and new nonignored files. Secret content is excluded. Unhashable projects, symlinks, oversized snapshots, or external changes prevent portable continuation.

```sh
smart --handoff TASK_ID       # explicitly reveals private context
smart --coordination TASK_ID  # sanitized Markdown on stdout
smart --continue TASK_ID      # explicit continuation, retaining counters
```

Only confirmed idle checkpoints with a recoverable native session can continue. Explicit cancellation remains `cancelled` even when its request outcome is uncertain; the inspection guard still prevents continuation or replay. After successful continuation, a resolved block reason is cleared from current status. A session created without a first turn may not yet have been persisted by the provider; its absence requires inspection. Prepared transitions and in-flight/uncertain requests require inspection; no tool replay is attempted. Project fingerprints must still match. Old checkpoints retain their original OpenCode session semantics and cannot acquire a fabricated portable objective. `/resume` remains available for legacy sessions; use `--continue` for portable tasks.

`/status`, `/history`, and ordinary exports include destination metadata and transition reasons but exclude private objectives and observations. No `COM.md` is created. Generated diagnostics, native sessions, pilot fixtures and reports must stay outside tracked public files.

## Local checks and optional real pilot

```sh
npm run smoke:continuity
npm run smoke:codex-policy  # requires the exact verified Codex binary; localhost only
npm run smoke:claude-policy # requires the exact verified Claude binary; localhost only
npm run pilot:continuity  # NOT_RUN; no provider inference
```

The continuity and reliability checks use simulated native processes; they include actual temporary file writes and independent local test commands, not model reasoning. The optional real pilot requires both `--run` and `--allow-subscription-usage`, an explicit configured chain, and a new output directory outside the repository. It checks every native policy preflight before any model request. It blocks before inference if any native preflight fails. It is not part of ordinary tests or CI. The real pilot above used Codex `gpt-6.1-sol` and Claude `sonnet`; its private reports retain blocked attempts as well as successful cases. Provider request counts and monetary subscription cost were not measured and must not be inferred from wrapper-request counts.

```sh
npm run pilot:continuity -- --run --allow-subscription-usage \
  --config ./subscription-pilot.json --output /tmp/smart-continuity-pilot
```

Running that command explicitly authorizes subscription consumption. No earlier benchmark budget is reused. Each scenario caps wrapper requests at four and bounds global observed model calls at the smaller of its configured limit and sixteen, retaining counters across a handoff. `--scenario codex-only`, `--scenario claude-only`, or `--scenario forced-stage-boundary-handoff` selects an individual case without rerunning accepted cases. A handoff case must confirm both expected destinations. Blocked or incomplete pilots exit unsuccessfully. Fixtures and reports are private and retained for inspection. This experimental feature makes no 24/7 availability, cost savings, quality equivalence, or production-readiness claim.

## Opt-in real lifecycle checks

The lifecycle pilot requires POSIX and Python 3 in addition to both authenticated native CLIs. Its controlling TTY approves only the named fixture file and the exact `npm test` command, or deliberately rejects them. It keeps terminal transcripts and reports in the new private output directory, outside the repository. It never changes the user's normal native configuration.

```sh
npm run pilot:lifecycle  # NOT_RUN; no provider inference
npm run pilot:lifecycle -- --run --allow-subscription-usage \
  --config ./subscription-pilot.json --output /tmp/smart-lifecycle-pilot
```

Use `--backend codex|claude` and `--case recovery|cancel-command|deny` to select individual cases. Recovery stops after a validated implementation and explicitly starts `smart --continue` in a fresh process; sessions, counters, API budget, project fingerprint and prior changes must be preserved. Cancellation sends SIGINT while a fixture-owned test child is running, requires that child to stop, and verifies that a subsequent continuation fails with the no-replay guard. Denial must leave files unchanged and cannot select the configured alternative backend. Each case uses a separate task with a global request/observed-step guard of at most sixteen; native per-request limits still apply. A first failing case stops the campaign for inspection. No invoice cap or exact provider-request count is inferred from these guards.

These real checks passed on 2026-10-19 with the pinned native versions and the same models as the addition pilot. Two defects found during the campaign were corrected: an uncertain cancellation was shown as blocked, and the last permitted Codex step could interrupt its own final answer. Earlier blocked attempts remain in the private evidence. The evidence covers controlled fixtures and graceful cancellation, not general hard-crash recovery, naturally occurring quota exhaustion, or production repositories.

## Protocol references

- [Codex app-server](https://learn.chatgpt.com/docs/app-server): sessions, dynamic tools, account and rate-limit RPCs.
- [Codex configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json): startup tool and agent controls. Smart verifies an exact local binary; a newer schema alone does not authorize a new version.
- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference): programmatic output and permission bridge.
- [Claude SDK stream events](https://code.claude.com/docs/en/agent-sdk/typescript): documented subscription rate-limit events.

Codex requires selected models to appear in its authenticated `model/list` response and in the native public model metadata cache. Smart copies only allowlisted model fields into its private restricted catalog; account identity and credentials are excluded. It fixes subscription traffic to the official ChatGPT backend, disables its owned provider's transport retries, and rejects API authentication. Claude's quota remains unknown until a documented event is observed; Smart does not query private endpoints or infer percentages.

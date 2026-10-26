# Local Factory MVP

Factory coordinates one task at a time around Smart Router's existing Engine. It
is tested with scripted offline fixtures and real local validation commands. No
real-model Factory pilot or production reliability has been demonstrated.

## Offline demonstration

```sh
npm run build
node dist/factory/cli.js --help
node dist/factory/cli.js demo
npm run test:factory
```

`demo` creates a dependency-free Git fixture in a private temporary directory. In
an interactive terminal approve the displayed write, independent `node --test`
command, and local commit to reach `READY_LOCAL`. No provider is started. Without
a terminal every approval is denied. The demo retains its private workspace and
prints the state location for inspection. `test:factory` reproduces the positive
and negative E2E cases without interaction, credentials or external services; its
approval providers are restricted to test fixtures. Simulated implementers supply
no executable validation evidence: separate real test processes provide it.

## Configure a task

Copy [the JSON example](factory-task.example.json), adjust the repository path,
local base ref, scope and commands, and use a new task ID. Relative repository
paths resolve from the current directory. Configure Smart Router as described in
[configuration](CONFIGURATION.md). Dependencies must already be available in the
new worktree; Factory never installs them or copies `node_modules`.

```sh
factory run --spec ./task.json
factory run --spec ./another-task.json --config ./smart-router.config.json --run
factory status parser-edge-cases
factory inspect parser-edge-cases
factory cancel parser-edge-cases
factory continue parser-edge-cases --run
factory deliver parser-edge-cases
```

The first invocation prepares an isolated worktree but denies inference. `--run`
only enables the prompt for a concrete provider/subscription execution; it does
not approve inference or tools. Inspect the displayed models, executables,
limits and operation before answering `yes`. Real execution may incur charges.
The original `smart` CLI and its configuration formats remain supported.

Scope is a delivery constraint, never a tool authorization. All writes/commands
still require individual host approval. Validation has its own exact approval,
outside model tools. Only direct supported checks are accepted: `node --test`,
`npm test`, selected `npm run` checks, and narrow pnpm/yarn/pytest/cargo/go checks.
Shell strings, installation commands, absolute command paths and traversal are
rejected. Commands run without a shell, with bounded output, a 60-second per-check
limit, an owned POSIX process group, private HOME and filtered environment.
Outputs are represented by digests, never persisted verbatim. A subsequent
content change invalidates the checks. Cancellation requires exit/process-group
evidence; uncertain termination retains the journal and locks for inspection.

**Approve only trusted local code.** Tests can execute repository code and access
the host filesystem, including secrets left in the repository. Worktrees and
environment filtering are not an OS sandbox. Factory does not support untrusted
repositories. Do not place production credentials next to candidate code.

## State, review and recovery

Private JSON state lives under `SMART_STATE_DIR/factory`, or the default Smart
state directory's `factory` child. Directories require 0700; files use 0600. State
and workspaces must be outside the repository. Factory and Smart share the project-lock root while Engine metadata stays private.
Programmatic hosts using custom roots must pass the same project lock root to
`Store(metadataRoot, lockRoot)` and `FactoryStore(factoryRoot, lockRoot)`.
IDs, base SHA, branch, Engine ID,
checks, content hashes, approval digests and durable transitions are retained.
Private `inspect` output includes objectives and local paths; do not publish it.
`status` emits reduced metadata, the Engine block reason and safe events. Inspection is read-only, including after a crash; it does not overwrite an active recovery owner. Routing classifies the objective alone; acceptance and scope remain separate model context. Original dirty changes are not
copied into the worktree. No base checkout reset, cleanup or automatic deletion
is performed.

`AWAITING_DELIVERY_APPROVAL` means static scope/evidence checks passed. Acceptance
criteria still require human review. There is no second model reviewer. Factory
adds no automatic repair loop (even if maxRepairAttempts is positive); existing
Engine repair limits remain in effect. Dependencies, lockfiles, workflows,
Git attributes/ignore files, secrets, submodules and symlinks cannot be delivered
in this MVP. Repository checkout filters/attributes and submodules are rejected.
Secret-pattern scanning is conservative and cannot prove absence of all secrets.

`continue` can inspect a fresh validated checkpoint, or explicitly resume a
blocked portable Engine checkpoint with identical execution configuration, an unchanged fingerprint and confirmed
idle native session. Engine counters are retained. Legacy sessions, cancelled
tasks and uncertain operations cannot be replayed. A cancellation request file
is consumed by the active owner; a request alone does not prove termination.
Stale locks are never automatically removed. After a crash inspect the operation,
Git state, provider session and owned children before manually reconciling state
or locks. There is no automated repair of ambiguous local commits/worktree adds.

## Delivery

`deliver` previews scope, diff and PR body, then requests separate consent for
local commit, remote inspection, push and Draft PR. It rechecks content/HEAD/base
and remote destination after approval. Git hooks and commit signing are disabled
for these owned operations. Only scoped changed files are staged. No tokens are
passed to model tools. Host Git/gh use the user's configured authentication. Approved host Git operations inherit only the selected GitHub credential-helper and SSH-agent settings; providers and independent validation do not receive delivery tokens.

With `delivery.draftPR: false`, successful delivery ends at `READY_LOCAL` with a
local commit. To publish, opt into `draftPR: true` before starting, configure a
matching GitHub `origin` fetch/push URL and authenticate the host `gh` CLI.
The PR targets `repository.baseRef` and always remains a draft. The body records
real independent exit codes and evidence digests, with acceptance criteria left
unchecked for the reviewer. There is no auto-merge, force push, deployment or npm
publication. Missing auth/client, denied remote approval or absent origin leaves
`READY_LOCAL`, with the commit and reason available through `inspect`. Suggested
manual commands after review are `git -C <workspace> show --stat HEAD`,
`git -C <workspace> push origin HEAD:refs/heads/<task-branch>` and
`gh pr create --draft --head <task-branch> --base <base-branch>`; each publication
still needs the user's authorization.

After an uncertain push/PR, a later `deliver` first asks to inspect remote refs
and PRs. A matching draft with the exact commit/base is reused. Conflicts block
publication. An absent remote branch after an uncertain push, or an absent PR after an uncertain create, requires manual inspection;
it is never automatically retried. Offline tests use local bare remotes and a
fake GitHub client, never GitHub itself. macOS and Linux arm64 were exercised
locally; hosted x64 CI remains pending. Windows validation is deliberately blocked.

## Programmatic Engine

Import `SmartEngine` and its declared input/result types from
`smart-router-cli/dist/engine/index.js` (or the source module during development).
The trusted host obtains inference consent before calling `run`, supplies a
concrete `approvals(description)` function and receives `{ taskId, result,
cancel }`. Tool approval defaults to denial. `inspect(id, canonicalProject)`
loads metadata without replay; `continue(id, input)` accepts portable checkpoints
only. Typed task/stage/routing/approval/result events omit prompts, operation
contents and streamed model output. Observer exceptions cannot grant permission
or alter execution. Always await `result` after requesting cancellation; the
returned abort boolean alone does not roll back or prove absence of earlier
changes. Backends are closed on settlement.

## Prepare a supervised real pilot (no inference)

```sh
npm run pilot:factory:prepare -- --output <new-private-directory-outside-Git> \
  --backend codex --model <explicit-available-model> --executable <trusted-codex-cli>
```

This development harness prepares a dependency-free parser repository, a committed
failing baseline (actual exit 1), TaskSpec and subscription configuration. It never
starts a provider, installs dependencies or publishes. The tests cover empty
input, CRLF, Unicode and preservation of spaces. Only `index.mjs` may change;
tests/package are protected. Inspect the generated files before authorizing work.
The original checkout must stay unchanged, the independent check must exit 0,
checks must match the final content hash, and delivery must remain local.

The prepared limits are three wrapper requests, five minutes, zero automatic
repairs/escalations/retries and no API budget. Subscription usage is real usage;
its monetary cost is unknown and these limits are not an invoice cap. Verify
provider billing settings and explicitly authorize this one pilot first.
Then, in a terminal, set `SMART_STATE_DIR` to a private sibling outside all Git
checkouts and run `factory run --spec <task.json> --config <config.json> --run`.
Every concrete edit/command still needs approval. Review `status`/`inspect` and
the diff before optionally invoking `deliver` for a separately approved local
commit. No remote origin is configured. Never run this preparation against
TraceLog, private production code or a repository with production credentials.

For a new native binary, run the appropriate policy smoke with
`--candidate-version <exact-version>` before editing the production version list.
This flag is confined to the scripted loopback harness; it cannot authorize an
unverified production backend. Keep all registry/policy assertions intact.
Existing Factory validations from before the stabilized content-hash encoding
are invalidated conservatively; inspection does not silently revalidate them.

## CI validation

The Linux workflow runs Node 22 and 24, the complete tests, independent validation,
continuity and package smokes. Dependency lifecycle scripts are disabled; the
trusted setup script copies the lockfile-pinned OpenCode optional binary. Package
smokes install against a frozen runtime lock, so a fresh npm-ci cache needs only
tarballs rather than previously cached registry metadata. No real model credentials
or native subscription authentication belong in CI. Native policy smokes are
separate, explicit loopback checks against each exact installed binary.

The stabilization checks were exercised on macOS and an isolated Linux arm64
container with Node 22 and 24, with networking disabled during validation. This
is local CI-equivalent evidence; GitHub-hosted x64 jobs were not triggered. The
prepared real-model pilot remains a separate human authorization and evidence gate.

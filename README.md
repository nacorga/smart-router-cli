# Smart Router CLI

Explainable model routing for coding tasks, built on OpenCode.

**Experimental alpha · MIT · Node.js 22+ · OpenCode SDK/server 1.19.3**

Smart Router selects `fast`, `balanced`, or `deep` for each stage of a task, keeps the native session context, and records why it changed models. It supports scoped approvals, validation evidence, bounded repairs, manual overrides, cancellation, and session inspection.

Cost savings with comparable quality are an **unproven hypothesis**. See the [historical evaluation](docs/BENCHMARK.md) for failures, budget cuts, and limitations.

## Try it without an API key

```sh
git clone https://github.com/nacorga/smart-router-cli.git
cd smart-router-cli
npm ci
npm run build
node dist/cli.js --help
node dist/cli.js --plan "Implement a parser"
node dist/cli.js --demo "Implement a parser"
```

`--plan` previews local routing; it does not check provider availability. `--demo` is an offline simulation: no tools, edits, model requests, or real validation. A simulated edit ends as `unverified`.

For a packaged installation, download the `.tgz` and checksum from [Releases](https://github.com/nacorga/smart-router-cli/releases), verify the checksum, then install the local file:

```sh
npm install --global ./smart-router-cli-0.1.0-alpha.2.tgz
smart --help
```

This alpha is distributed on GitHub, not the npm registry. macOS and Linux are checked in CI; Windows is not yet validated.

## Configure real tasks — paid inference

In the target repository, run `smart --init` (or invoke this clone's `dist/cli.js` by its absolute path). Replace all three model placeholders with available IDs in the form `openrouter/vendor/model-id`. Each selected model must support tools and the configured context size.

Create `.env` in that target repository:

```dotenv
OPENROUTER_API_KEY=your_local_key
```

The key is read locally; an existing environment variable takes precedence. Do not commit or share it. Then:

```sh
smart "Explain where this repository validates input"
smart "Add tests for the parser"
smart
```

**These commands contact the provider and can incur charges.** Relevant repository content and prompts may be sent to OpenRouter and its downstream provider. Writes and commands require approval; a non-interactive process rejects them. Inspect the exact operation before answering `yes`.

## Routing and controls

| Task | Default route |
| --- | --- |
| Read or explain | Fast exploration |
| Small typo | Fast implementation |
| Ordinary change | Fast exploration, Balanced implementation and validation |
| Architecture or migration | Additional Deep planning |
| Sensitive change | Deep planning, validation, and structured review |

The classifier recognizes English and Spanish. Ambiguous tasks take a conservative route. A reproduced validation failure may trigger a bounded repair and escalation; permission, provider, and local-limit failures are treated separately.

| Command | Effect |
| --- | --- |
| `/mode auto` or `/mode manual` | Select routing mode |
| `/model fast`, `balanced`, `deep`, or `provider/id` | Persistent override until revoked |
| `/budget 2` | Limit new wrapper requests |
| `/status`, `/history`, `/sessions` | Inspect metadata, decisions, and tasks |
| `/resume [id]` | Inspect a checkpoint; the next explicit task continues an idle native session |
| `/cancel` or Ctrl-C | Abort the active request and stop later stages |
| `/exit` | Close the session |

A change is `completed` only with executed validation evidence. `unverified` is not success. Structured review findings can still fail a task. Session inspection never automatically replays tools.

## Costs, privacy, and boundaries

The general CLI checks budget **between wrapper requests**. One request can contain several native tool turns and may exceed the remaining amount. It is not a hard monetary cap. Use provider-side limits when required. Missing cost evidence blocks new requests; backend-reported cost is not an invoice. The benchmark has a separate provider-cost meter.

Smart Router stores task metadata, usage, decision reasons, and validation hashes locally. OpenCode retains its own native history, which may include prompts and source code. Approvals are not an operating-system sandbox; earlier tool effects are not rolled back after cancellation.

Read [configuration](docs/CONFIGURATION.md), [security and privacy](SECURITY.md), [architecture](docs/ARCHITECTURE.md), and [evaluation limits](docs/BENCHMARK.md).

## Reproduce reliability checks

The reliability tooling adds ten controlled tasks across three fixture projects, an offline 60-slot rehearsal, and local failure injection. These are not results on real repositories. See the [reliability protocol](docs/RELIABILITY.md) for commands, frozen criteria, reporting, and the separately gated paid campaign.

## Develop and contribute

```sh
npm test
npm run test:permissions
npm run typecheck
npm run build
npm run audit:public
npm run smoke:package
npm run smoke:validation
```

Ordinary tests and smokes need no API credentials and make no paid model requests. Native smokes use scripted providers on loopback and isolated state; they do not measure model quality. See [CONTRIBUTING](CONTRIBUTING.md), the [roadmap](docs/ROADMAP.md), and the [demo](docs/DEMO.md).

Useful feedback includes a reproducible task, expected behavior, version/platform, and a sanitized failure report. Report vulnerabilities privately as described in SECURITY. Do not attach keys, native histories, or confidential source code.

## Experimental subscription continuity

An opt-in version 2 configuration adds sequential destinations and private continuation checkpoints. Existing OpenCode/OpenRouter configurations are unchanged. Start with `smart --init --subscriptions`, configure native models, and inspect `smart --backends` without inference.

**Experimental continuity:** both adapters use closed Smart tools and have deterministic process-contract coverage, including bidirectional handoffs. An authorized real pilot passed for Codex alone, Claude alone, and a deliberate Codex → Claude handoff on one isolated addition fixture, preserving existing work and independently validating the result. Further real fixture checks passed for the reverse handoff, cross-process continuation, cancellation during validation, and permission rejection in both backends. Real quota exhaustion and broader real tasks remain unvalidated. Read [continuity status, permissions, and recovery](docs/CONTINUITY.md) before enabling this experimental route.

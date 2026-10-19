# Architecture

CLI → Controller → Backend interface → OpenCodeBackend → dedicated OpenCode server → OpenRouter/model provider.

The CLI owns command parsing and approval UI. The deterministic router classifies English/Spanish tasks, chooses stages and model tiers, and records reason codes. The controller owns checkpoints, handoff observations, bounded repairs/escalation, budget checks, and cancellation. The SDK adapter sets the selected model on each native request and applies the complete stage permission rules.

A read normally needs one Fast exploration. Ordinary changes use Fast exploration and Balanced implementation/validation; complex work adds Deep planning. Sensitive work gets Deep validation and schema-checked review. Unknown tasks use a conservative route. Model switches occur between requests; the native session retains the goal and history.

Validation requires a completed native bash tool, an allowed recognized direct validation command, and a structured integer exit code after the last known edit. Prose is not evidence. Chained or redirected commands are not accepted as checks. Reproduced failures can escalate after bounded repair; provider, permission, and local-guard failures do not indicate insufficient model capability.

The adapter uses a dedicated loopback server. With this SDK version the legacy prompt.tools field can replace session permissions, so it is omitted and the full stage policy is explicitly restored. Review requests return a JSON object in text; the wrapper validates verdict and findings instead of using the incompatible native structured-output mode.

Task state is atomic private JSON plus a canonical project lock. It stores references, usage, decisions, and validation hashes, not copies of prompts/responses. Native OpenCode history is separate. Resume is inspection first, followed by explicit continuation; there is no automatic rollback or crash replay.

The benchmark uses identical isolated fixtures for Smart and Deep-only and retrieves costs from provider generation receipts. Failed, unmatched, censored, and unknown-cost rows must remain visible. The optional text-only relay reserves conservative input/output cost before forwarding and marks proven pre-provider denials as local limits. These extra experimental controls are not enabled as a hard spending cap in the general CLI.

Development smokes define a local fake model catalog and scripted loopback provider, use dummy credentials and isolated XDG state, and write temporary reports. They verify native integration without measuring model quality.

## Experimental sequential destinations

Version 2 destination configurations select a separate continuity controller; legacy tasks retain the original controller and adapter. Availability and explicit pre-tool quota rejections select the next declared destination without resetting task counters. Authentication, permissions, local limits, unknown API cost, and uncertain effects do not trigger failover.

A private handoff store contains the objective and bounded untrusted observations, separate from metadata exports. Prepared/committed transitions and in-flight request markers are durable before inference. Continuation requires an idle confirmed checkpoint and an unchanged Git/index/worktree fingerprint. Native sessions are associated with destinations.

Claude's native tool set is disabled in favor of an authenticated loopback MCP bridge executing Smart-controlled operations; the initialization event is checked before tools can act. Codex owns an app-server with a restricted model catalog, disabled native tools/extensions/agents, verified configuration layers and four Smart dynamic tools. Both share one operation broker, concrete approvals and real command exit evidence. Its native tool registry is verified against a local scripted provider; only subscription authentication and explicitly selected available models are accepted. See [continuity status and operating limits](CONTINUITY.md). A separately authorized real addition-fixture pilot passed for each backend and Codex → Claude continuity; a subsequent authorized lifecycle pilot covers reverse handoff, cross-process continuation, SIGINT cancellation and denied permissions for both backends. Actual quota exhaustion and general hard crashes remain outside that evidence.

# Architecture

CLI → Controller → Backend interface → OpenCodeBackend → dedicated OpenCode server → OpenRouter/model provider.

The CLI owns command parsing and approval UI. The deterministic router classifies English/Spanish tasks, chooses stages and model tiers, and records reason codes. The controller owns checkpoints, handoff observations, bounded repairs/escalation, budget checks, and cancellation. The SDK adapter sets the selected model on each native request and applies the complete stage permission rules.

A read normally needs one Fast exploration. Ordinary changes use Fast exploration and Balanced implementation/validation; complex work adds Deep planning. Sensitive work gets Deep validation and schema-checked review. Unknown tasks use a conservative route. Model switches occur between requests; the native session retains the goal and history.

Validation requires a completed native bash tool, an allowed recognized direct validation command, and a structured integer exit code after the last known edit. Prose is not evidence. Chained or redirected commands are not accepted as checks. Reproduced failures can escalate after bounded repair; provider, permission, and local-guard failures do not indicate insufficient model capability.

The adapter uses a dedicated loopback server. With this SDK version the legacy prompt.tools field can replace session permissions, so it is omitted and the full stage policy is explicitly restored. Review requests return a JSON object in text; the wrapper validates verdict and findings instead of using the incompatible native structured-output mode.

Task state is atomic private JSON plus a canonical project lock. It stores references, usage, decisions, and validation hashes, not copies of prompts/responses. Native OpenCode history is separate. Resume is inspection first, followed by explicit continuation; there is no automatic rollback or crash replay.

The benchmark uses identical isolated fixtures for Smart and Deep-only and retrieves costs from provider generation receipts. Failed, unmatched, censored, and unknown-cost rows must remain visible. The optional text-only relay reserves conservative input/output cost before forwarding and marks proven pre-provider denials as local limits. These extra experimental controls are not enabled as a hard spending cap in the general CLI.

Development smokes define a local fake model catalog and scripted loopback provider, use dummy credentials and isolated XDG state, and write temporary reports. They verify native integration without measuring model quality.

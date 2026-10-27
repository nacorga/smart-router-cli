# Configuration

Node.js 22+ and Git are required. OpenCode SDK/server are pinned to 1.19.3. Run smart --init in your target project; it creates the configuration exclusively and refuses to overwrite it.

Configuration combines defaults, the user configuration at $XDG_CONFIG_HOME/smart-router/config.json (or ~/.config/smart-router/config.json), and smart-router.config.json at the Git root. --config selects an explicit file instead of the normal user/project files.

Set models.fast, models.balanced, and models.deep to tool-capable provider/model IDs such as openrouter/vendor/model-id. Placeholders intentionally fail before inference. All planned routes are checked for model availability, tools, and minContext before the first task prompt. fallbacks.fast/balanced/deep can declare alternatives; replacements are recorded rather than silent.

mode is auto or manual. Manual defaults to Balanced until an override is selected. /mode auto revokes the override; --deep-only forces Deep for comparison. --plan shows local decisions without calling a provider or verifying availability.

limits.maxCostUsd controls new API requests. maxModelCalls caps wrapper prompts across destinations and continuation. Subscription usage records do not count as additional prompts; native adapters independently limit each invocation to eight agent steps. API destinations retain the additional conservative guard on observed usage records. The other limits bound repairs, escalations, and infrastructure retries. The general CLI cannot guarantee a hard invoice cap for an in-flight request or subscription usage.

Put OPENROUTER_API_KEY in the environment or the target project's .env. Only that variable is loaded; an existing environment value wins. Do not commit credentials or your real model configuration.

smart --sessions, --resume, and --export inspect metadata without inference. In interactive mode /resume loads a checkpoint; a subsequent explicit task continues only after confirming that the native session is idle and belongs to the project. Interrupted tools are never replayed automatically.

Exit status is nonzero for failed, blocked, or cancelled real tasks. An unverified edit is explicitly labeled and must not be treated as a verified result. Approval accepts yes (and si/sí for compatibility); other replies reject the operation.

## Version 2 subscription destinations

`smart --init --subscriptions` writes an opt-in Codex → Claude template. Each destination declares `id`, `backend`, `billing`, and explicit `models.fast/balanced/deep`; `executable` optionally selects a trusted local CLI. Only `opencode` accepts `api` billing; `codex` and `claude` require `subscription`. Destination IDs are unique. Normal user/project configuration precedence still applies, and a destination array is replaced as a whole.

Legacy model fallbacks are not reused across destinations. The subscription template does not add OpenRouter to the chain. `--plan` lists ordered candidates without verifying availability. `--backends` diagnoses native authentication and policy compatibility without inference and quota observations. See [continuity](CONTINUITY.md) before enabling native execution or storing private handoff content.

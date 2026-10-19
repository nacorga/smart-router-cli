# v0.1.0-alpha.1

First public experimental alpha of Smart Router CLI.

- Explainable deterministic routing across Fast, Balanced, and Deep.
- Native OpenCode session continuity, staged permissions, manual overrides, checkpoints, cancellation, and explicit continuation.
- Executed validation evidence, bounded repair/escalation, structured review, and separate handling of local limits.
- Local scripted native smokes and a reproducible 20-case synthetic benchmark runner.
- English CLI and documentation; English/Spanish task classification.

Local checks and GitHub CI cover Node 22/24 on Linux and native smoke workflows on macOS with Node 24. CI evidence applies to the release commit; Windows is not validated. Tests with a scripted provider do not establish real-model quality.

Historical experiments predate this public commit. They contain incorrect implementations, permission failures, infrastructure interruptions, and budget cuts. They do not establish cost savings at comparable quality.

The general CLI budget is checked between requests, not a hard provider invoice cap. Native history can contain source code and prompts; approval is not an OS sandbox. Treat this alpha as an experiment in a disposable checkout.

The GitHub prerelease provides an npm-compatible local-install .tgz and a SHA-256 checksum. npm registry publishing is disabled.

# Contributing

Start with a small reproducible bug or a new evaluation case. This alpha prioritizes completed workflows, correct validation evidence, and transparent cost accounting.

## Setup

Use Node.js 22 or 24 and Git. Native/TTY checks also require Python 3 and macOS or Linux.

```sh
npm ci
npm test
npm run test:permissions
npm run typecheck
npm run build
npm run audit:public
npm run smoke:package
```

Native development checks: `npm run smoke:server`, `smoke:permissions`, `smoke:cli`, `smoke:review`, `smoke:controls`, `smoke:validation`, `smoke:budget`, and `smoke:tty`. They use isolated fixtures and no real model credentials. Generated reports belong in temporary directories or ignored local artifacts. Ordinary checks must leave tracked files unchanged.

Paid diagnostics and the benchmark are separate, explicit opt-in commands. Never run them in CI or use maintainer secrets. Read the benchmark documentation before invoking --run; using real models costs money even when a task fails.

## Pull requests

Describe the trigger, observed behavior, fix, and checks run. Preserve the CLI flags, config keys, status codes, English/Spanish task classification, and existing user edits. Keep permission checks separate from model text. Never turn missing validation or cost evidence into success. Add a focused regression for behavior changes; avoid tests that merely repeat the implementation.

Do not commit .env files, local model configuration, native sessions, billing exports, raw task transcripts, screenshots, tarballs, or confidential source code. The public historical results are intentionally sanitized and remain separate from future runs. Changes to measured criteria must be documented as a new evaluation version.

The project uses MIT. Retain applicable notices when contributing third-party material. For vulnerabilities, follow SECURITY rather than filing a public issue.

## Reliability evaluation

Run `npm run test:reliability` for the local HTTP fault battery and harness checks. `npm run reliability -- --verify-fixtures` accepts references and rejects broken baselines/mutants without credentials. Read [the protocol](docs/RELIABILITY.md) before freezing a campaign. Never put `--run` in CI. New external tasks should use the prospective case template and remain separate from the public fixture suite.

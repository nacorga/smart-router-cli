# Offline demonstration

Build the project, then run:

```sh
node dist/cli.js --plan "Implement a parser"
node dist/cli.js --demo "Implement a parser"
```

The preview shows Fast exploration followed by Balanced implementation and validation. The demo prints simulated stage responses and a zero cost, ending the edit as unverified. It does not read or edit project files, run validation commands, or contact a model provider. It may persist its simulated task metadata locally.

For a real task, configure tool-capable models and a local API key, run the CLI from a disposable repository, and inspect each requested operation. That path is paid and must not be presented as part of this zero-cost demonstration.

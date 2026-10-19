import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
// Contract processes are local fixtures; this command never starts either installed provider CLI.
const { stdout } = await exec('npm', ['test', '--', 'tests/continuity.test.ts', 'tests/native-backends.test.ts', 'tests/codex-backend.test.ts', 'tests/claude-recovery.test.ts', 'tests/native-tools.test.ts', 'tests/continuity-lifecycle.test.ts', 'tests/reliability-continuity.test.ts'], { cwd: process.cwd(), timeout: 120000, maxBuffer: 1024 * 1024 });
console.log(stdout);
console.log(JSON.stringify({ status: 'passed', kind: 'simulated-native-continuity', realProviderInferenceRequests: 0, billableCostUsd: 0 }));

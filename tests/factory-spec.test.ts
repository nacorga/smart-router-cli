import { it, expect } from 'vitest';
import { parseTaskSpec, matches, validateCommand } from '../src/factory/task-spec.js';
import { repositoryFixture as fixture } from './factory-repository.js';
it('strictly validates the schema and refuses injection or permissions in TaskSpec', async () => {
  const f = await fixture();
  try {
    expect(parseTaskSpec(f.spec)).toEqual(f.spec);
    for (const mutate of [
      (s: any) => { s.approvals = true; }, (s: any) => { s.version = 2; },
      (s: any) => { s.repository.baseRef = '--upload-pack=evil'; }, (s: any) => { s.id = '../escape'; },
      (s: any) => { s.scope.allowedPaths = ['../**']; }, (s: any) => { s.scope.allowedPaths = ['/tmp/**']; },
      (s: any) => { s.delivery.requireHumanApproval = false; }, (s: any) => { s.limits.maxRepairAttempts = 3; },
      (s: any) => { s.validation.commands[0].args = ['--eval', 'evil']; },
      (s: any) => { s.validation.commands[0].executable = '/bin/sh'; },
    ]) { const spec = structuredClone(f.spec); mutate(spec); expect(() => parseTaskSpec(spec)).toThrow(); }
    expect(() => validateCommand({ executable: 'npm', args: ['test', ';', 'touch', 'x'], required: true })).toThrow();
    expect(() => validateCommand({ executable: 'npm', args: ['install'], required: true })).toThrow();
    expect(matches('src/deep/file.ts', 'src/**')).toBe(true); expect(matches('outside/file.ts', 'src/**')).toBe(false);
  } finally { await f.cleanup(); }
});

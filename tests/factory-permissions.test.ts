import { it, expect } from 'vitest';
import { withoutDeliveryCredentials } from '../src/engine/environment.js';
import { subscriptionEnvironment } from '../src/native-transport.js';
it('removes delivery tokens from provider/tool environments while preserving host auth', () => {
  const source = { PATH: '/usr/bin', GH_TOKEN: 'fixture-private-host-token', GITHUB_TOKEN: 'fixture-private-host-token', GH_ENTERPRISE_TOKEN: 'fixture-enterprise', GITHUB_ENTERPRISE_TOKEN: 'fixture-enterprise', OPENROUTER_API_KEY: 'fixture-api' };
  expect(withoutDeliveryCredentials(source)).toEqual({ PATH: '/usr/bin', OPENROUTER_API_KEY: 'fixture-api' });
  const previous = process.env.GH_TOKEN;
  try { process.env.GH_TOKEN = source.GH_TOKEN; expect(subscriptionEnvironment().GH_TOKEN).toBeUndefined(); expect(process.env.GH_TOKEN).toBe(source.GH_TOKEN); }
  finally { if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous; }
});
it('rejects state inside the repository before persisting private objectives', async () => {
  const { fixture } = await import('./factory-helpers.js');
  const { Factory } = await import('../src/factory/orchestrator.js');
  const { FactoryStore } = await import('../src/factory/state.js');
  const { join } = await import('node:path'); const { readdir } = await import('node:fs/promises');
  const f = await fixture(); const unsafe = new FactoryStore(join(f.repo, 'factory-state'));
  try {
    const factory = new Factory(unsafe, f.factory.engine, f.config, async () => true, 'offline-fixture');
    await expect(factory.run({ ...f.spec, objective: 'PRIVATE_OBJECTIVE_MUST_NOT_BE_SAVED' })).rejects.toThrow('PRIVATE_STATE_MUST_BE_OUTSIDE');
    expect(await readdir(unsafe.root)).toEqual([]);
  } finally { await f.cleanup(); }
});
it('keeps host delivery authentication available to Git without exposing it to providers', async () => {
  const { GhClient } = await import('../src/factory/delivery.js');
  const { hostEnvironment } = await import('../src/factory/workspace.js');
  const previousToken = process.env.GH_TOKEN, previousAgent = process.env.SSH_AUTH_SOCK;
  try {
    process.env.GH_TOKEN = 'fixture-host-delivery-only'; process.env.SSH_AUTH_SOCK = '/fixture/owned-agent';
    expect(new GhClient().gitEnvironment()).toMatchObject({ GH_TOKEN: 'fixture-host-delivery-only', SSH_AUTH_SOCK: '/fixture/owned-agent' });
    expect(hostEnvironment().GH_TOKEN).toBeUndefined(); expect(subscriptionEnvironment().GH_TOKEN).toBeUndefined();
  } finally {
    if (previousToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previousToken;
    if (previousAgent === undefined) delete process.env.SSH_AUTH_SOCK; else process.env.SSH_AUTH_SOCK = previousAgent;
  }
});

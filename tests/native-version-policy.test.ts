import { it, expect } from 'vitest';
import { codexPolicyVersions } from '../src/codex-policy.js';
import { claudePolicyVersions, claudeSettings, supportedClaudeVersion } from '../src/claude-policy.js';
import { subscriptionEnvironment } from '../src/native-transport.js';
it('accepts only exact native versions whose unchanged closed-tool contracts passed', () => {
  expect(codexPolicyVersions).toEqual(['codex-cli 0.163.0-alpha.10.2', 'codex-cli 0.164.0-alpha.11.1']);
  for (const version of claudePolicyVersions) expect(supportedClaudeVersion(version)).toBe(true);
  for (const version of ['2.1.303-unsafe', '2.1.310', '2.1.311 (Claude Code)', '2.1.303 (Claude Code) extra']) expect(supportedClaudeVersion(version)).toBe(false);
  expect(claudeSettings().env.ENABLE_TOOL_SEARCH).toBe('false');
  const prior = process.env.ENABLE_TOOL_SEARCH;
  try { process.env.ENABLE_TOOL_SEARCH = 'true'; expect(subscriptionEnvironment().ENABLE_TOOL_SEARCH).toBe('false'); }
  finally { if (prior === undefined) delete process.env.ENABLE_TOOL_SEARCH; else process.env.ENABLE_TOOL_SEARCH = prior; }
});

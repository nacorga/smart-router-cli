/** Exact native profiles verified with the closed-tool loopback smoke. */
export const claudePolicyVersions = ['2.1.303 (Claude Code)', '2.1.310 (Claude Code)'] as const;
export const supportedClaudeVersion = (version: string) => claudePolicyVersions.some(verified => verified === version);
export function claudeSettings(pluginIds: string[] = []) {
  return { env: { ENABLE_TOOL_SEARCH: 'false' }, disableAllHooks: true, hooks: {}, enabledPlugins: Object.fromEntries(['cc-plugin-agents-md@builtin', 'cc-plugin-plugin-authoring@builtin', 'cc-plugin-telemetry@builtin', ...pluginIds].map(id => [id, false])), permissions: { defaultMode: 'default' } };
}
export function verifyClaudeTools(event: Record<string, any>, model: string) {
  const allowed = new Set(['mcp__smart__permission', 'mcp__smart__read_file', 'mcp__smart__list_files', 'mcp__smart__write_file', 'mcp__smart__run_command']);
  if (!Array.isArray(event.tools) || !event.tools.every((name: unknown) => typeof name === 'string' && allowed.has(name)) || !event.tools.includes('mcp__smart__read_file')) throw new Error('CLAUDE_EFFECTIVE_TOOLS_UNVERIFIED');
  if (typeof event.model !== 'string' || (['sonnet', 'haiku', 'opus'].includes(model) ? !event.model.includes(model) : event.model !== model)) throw new Error('MODEL_SUBSTITUTION_DENIED');
  if (!Array.isArray(event.plugins) || event.plugins.length) throw new Error('UNEXPECTED_PLUGIN');
}

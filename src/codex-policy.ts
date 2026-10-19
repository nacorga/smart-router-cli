import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** Pinning this policy requires the native scripted-provider smoke, not a model's assertion. */
export const codexPolicyVersion = 'codex-cli 0.163.0-alpha.10.2';
export function featureNames(output: string): string[] {
  const rows = output.trim().split('\n').map(line => line.trim().split(/\s+/)).filter(row => row[1] !== 'removed').map(row => row[0]!).filter(name => /^[a-z][a-z0-9_]*$/.test(name));
  if (!['shell_tool', 'hooks', 'plugins', 'apps', 'view_image', 'multi_agent_v2'].every(name => rows.includes(name))) throw new Error('CODEX_FEATURE_CONTRACT_UNVERIFIED');
  return [...new Set(rows)];
}
export function codexPolicyArgs(features: string[], disabledServers: string[] = []) {
  // Dotted CLI paths do not parse quoted key segments. Quote server names inside the TOML value instead.
  const servers = '{' + disabledServers.map(name => `${JSON.stringify(name)}={enabled=false}`).join(',') + '}';
  return ['-c', 'agents.enabled=false', '-c', 'notify=[]', '-c', 'web_search="disabled"', '-c', 'tools.update_plan.enabled=false', '-c', 'tools.experimental_request_user_input.enabled=false', '-c', `mcp_servers=${servers}`, ...features.flatMap(name => ['-c', `features.${name}=false`])];
}
const metadataFields = ['slug', 'display_name', 'description', 'default_reasoning_level', 'supported_reasoning_levels', 'shell_type', 'visibility', 'supported_in_api', 'priority', 'additional_speed_tiers', 'service_tiers', 'available_access_programs', 'availability_nux', 'upgrade', 'model_messages', 'include_skills_usage_instructions', 'include_plugin_usage_instructions', 'include_apps_usage_instructions', 'default_reasoning_summary', 'support_verbosity', 'default_verbosity', 'apply_patch_tool_type', 'web_search_tool_type', 'truncation_policy', 'supports_image_detail_original', 'context_window', 'max_context_window', 'comp_hash', 'effective_context_window_percent', 'experimental_supported_tools', 'input_modalities', 'supports_search_tool', 'supports_experimental_context', 'use_responses_lite', 'supports_reasoning_effort_updates', 'node_repl_auto_review_required', 'node_repl_disabled', 'tool_mode', 'multi_agent_version', 'multi_agent_reasoning_effort'];
export function restrictedCodexModel(metadata: Record<string, any>) {
  if (typeof metadata.slug !== 'string' || !Number.isSafeInteger(metadata.context_window) || metadata.context_window < 1) throw new Error('CODEX_MODEL_METADATA_UNAVAILABLE');
  return { ...Object.fromEntries(metadataFields.filter(k => k in metadata).map(k => [k, metadata[k]])), shell_type: 'disabled', apply_patch_tool_type: null, tool_mode: null, experimental_supported_tools: [], include_skills_usage_instructions: false, include_plugin_usage_instructions: false, include_apps_usage_instructions: false, supports_search_tool: false, use_responses_lite: false, supported_in_api: true };
}
export async function cachedCodexModels(ids: string[], available: Set<string>) {
  // Only public model metadata is read. Account identity, auth files and tokens are never copied.
  const requested = [...new Set(ids)];
  if (requested.some(id => !available.has(id))) throw new Error('CODEX_MODEL_NOT_AVAILABLE');
  const cache = JSON.parse(await readFile(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json'), 'utf8'));
  return requested.map(id => {
    const model = cache.models?.find((m: any) => m.slug === id);
    if (!model) throw new Error('CODEX_MODEL_METADATA_UNAVAILABLE');
    return restrictedCodexModel(model);
  });
}
export function verifyCodexPolicy(config: Record<string, any>, features: string[], catalog: string, provider: string, layers: any[] = []) {
  const flags = layers.find(layer => layer.name?.type === 'sessionFlags' && !layer.disabledReason)?.config;
  return config.model_catalog_json === catalog && config.model_provider === provider && config.agents?.enabled === false && config.web_search === 'disabled' && flags?.tools?.update_plan?.enabled === false && flags?.tools?.experimental_request_user_input?.enabled === false && features.every(name => config.features?.[name] === false) && (!Array.isArray(config.notify) || config.notify.length === 0) && Object.values(config.mcp_servers ?? {}).every((server: any) => server.enabled === false);
}

/** Native inventory includes explicitly disabled servers; none may have a live connection/catalog. */
export function inactiveCodexMcp(result: any): boolean {
  return Array.isArray(result?.data) && !result.nextCursor && result.data.every((server: any) => server.runtimeStatus === 'disabled' && server.serverInfo == null && server.serverCapabilities == null && server.tools && Object.keys(server.tools).length === 0 && Array.isArray(server.resources) && server.resources.length === 0 && Array.isArray(server.resourceTemplates) && server.resourceTemplates.length === 0);
}

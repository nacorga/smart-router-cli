/** Delivery credentials belong to host Git/gh, never provider or model-tool children. */
export function withoutDeliveryCredentials(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[key];
  return env;
}

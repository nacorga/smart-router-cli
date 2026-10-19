import type { Availability } from './types.js';
/** SDKRateLimitEvent: only credits_required proves included subscription usage is exhausted. */
export function claudeQuota(event: Record<string, any>, sessionId: string): Availability | undefined {
  if (event.type !== 'rate_limit_event' || event.session_id !== sessionId) return;
  const info = event.rate_limit_info;
  if (!info || !['allowed', 'allowed_warning', 'rejected'].includes(info.status)) return;
  const exhausted = info.status === 'rejected' && info.errorCode === 'credits_required';
  if (info.status === 'rejected' && !exhausted) return;
  const resetsAt = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) && info.resetsAt > 0 && info.resetsAt < 8.64e12 ? new Date(info.resetsAt * 1000).toISOString() : undefined;
  return { state: exhausted ? 'exhausted' : 'available', source: 'SDKRateLimitEvent', observedAt: new Date().toISOString(), ...(resetsAt ? { resetsAt } : {}) };
}

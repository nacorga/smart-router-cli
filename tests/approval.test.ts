import { expect, it, vi } from 'vitest';
import { awaitApproval } from '../src/approval.js';

it('does not display an already expired approval', async () => {
  const abort = new AbortController(); abort.abort(); const host = vi.fn(async () => true);
  expect(await awaitApproval(host, 'write', abort.signal)).toBe(false); expect(host).not.toHaveBeenCalled();
});
it('expires a legacy host that ignores cancellation and discards its late yes', async () => {
  const abort = new AbortController(); let answer!: (value: boolean) => void;
  const pending = awaitApproval(() => new Promise<boolean>(r => { answer = r; }), 'write', abort.signal);
  await Promise.resolve(); abort.abort(); expect(await pending).toBe(false);
  answer(true); expect(await pending).toBe(false);
});
it('passes the exact operation signal and rejects a yes supplied by an abort listener', async () => {
  const abort = new AbortController(); let observed: AbortSignal | undefined;
  const pending = awaitApproval((_description, signal) => new Promise<boolean>(resolve => {
    observed = signal; signal!.addEventListener('abort', () => resolve(true), { once: true });
  }), 'write', abort.signal);
  await Promise.resolve(); abort.abort(); expect(await pending).toBe(false); expect(observed).toBe(abort.signal);
});
it.each([true, false])('preserves a legacy host decision: %s', async decision => {
  expect(await awaitApproval(async () => decision, 'write')).toBe(decision);
});
it('denies a failed host without leaving an unresolved request', async () => {
  expect(await awaitApproval(async () => { throw new Error('Unavailable'); }, 'write')).toBe(false);
});

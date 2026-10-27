import { afterEach, expect, it, vi } from 'vitest';
import { NativeTurnDeadline } from '../src/native-deadline.js';
afterEach(() => { vi.useRealTimers(); });
const clock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });

it('pauses only human waiting and retains the remaining active execution budget', async () => {
  clock(); const expired = vi.fn(); const deadline = new NativeTurnDeadline(expired);
  await vi.advanceTimersByTimeAsync(20000); let answer!: () => void;
  const wait = deadline.approval(() => new Promise<void>(r => { answer = r; }));
  await vi.advanceTimersByTimeAsync(130000); expect(expired).not.toHaveBeenCalled();
  answer(); await wait;
  await vi.advanceTimersByTimeAsync(99999); expect(expired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(expired).toHaveBeenCalledExactlyOnceWith('CODEX_TURN_TIMEOUT');
});
it('retains a five-minute wall cap during an unanswered approval', async () => {
  clock(); const expired = vi.fn(); const deadline = new NativeTurnDeadline(expired); let answer!: () => void;
  const wait = deadline.approval(() => new Promise<void>(r => { answer = r; }));
  await vi.advanceTimersByTimeAsync(300000); expect(expired).toHaveBeenCalledExactlyOnceWith('CODEX_WALL_TIMEOUT');
  answer(); await wait; await vi.advanceTimersByTimeAsync(300000); expect(expired).toHaveBeenCalledTimes(1);
});
it('does not reset the wall deadline across separate approvals', async () => {
  clock(); const expired = vi.fn(); const deadline = new NativeTurnDeadline(expired);
  for (let i = 0; i < 2; i++) {
    let answer!: () => void; const wait = deadline.approval(() => new Promise<void>(r => { answer = r; }));
    await vi.advanceTimersByTimeAsync(140000); answer(); await wait;
  }
  await vi.advanceTimersByTimeAsync(20000); expect(expired).toHaveBeenCalledExactlyOnceWith('CODEX_WALL_TIMEOUT');
});
it('resumes active accounting after a rejected approval provider and disposes both timers', async () => {
  clock(); const expired = vi.fn(); const deadline = new NativeTurnDeadline(expired);
  await expect(deadline.approval(async () => { throw new Error('Unavailable'); })).rejects.toThrow('Unavailable');
  await vi.advanceTimersByTimeAsync(120000); expect(expired).toHaveBeenCalledExactlyOnceWith('CODEX_TURN_TIMEOUT');
  deadline.dispose(); await vi.advanceTimersByTimeAsync(300000); expect(expired).toHaveBeenCalledTimes(1);
});

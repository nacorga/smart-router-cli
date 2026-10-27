/** Host-owned authorization. The optional signal expires this exact operation. */
export type ApprovalProvider = (description: string, signal?: AbortSignal) => Promise<boolean>;

/** Legacy one-argument hosts remain supported; their late answers cannot grant permission. */
export async function awaitApproval(provider: ApprovalProvider, description: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  let cancel: (() => void) | undefined;
  try {
    const aborted = new Promise<boolean>(resolve => {
      cancel = () => resolve(false);
      signal?.addEventListener('abort', cancel, { once: true });
    });
    const answer = Promise.resolve().then(() => signal?.aborted ? false : provider(description, signal));
    return await Promise.race([answer, aborted]) === true && !signal?.aborted;
  } catch { return false; }
  finally { if (cancel) signal?.removeEventListener('abort', cancel); }
}

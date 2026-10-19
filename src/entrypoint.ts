import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/** Installed bin symlinks and macOS temporary-directory aliases must resolve to the same entrypoint. */
export function isMain(url: string): boolean {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url)); }
  catch { return false; }
}

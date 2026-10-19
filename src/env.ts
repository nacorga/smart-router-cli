import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/** Load only the requested provider credential; shell variables take precedence. */
export async function loadLocalEnv(directory: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(join(directory, '.env'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Could not read the project .env file.');
  }
  const values = parseEnv(content);
  if (process.env.OPENROUTER_API_KEY === undefined && values.OPENROUTER_API_KEY !== undefined) {
    process.env.OPENROUTER_API_KEY = values.OPENROUTER_API_KEY;
  }
}

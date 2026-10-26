// Safe CI setup: npm ci --ignore-scripts verifies lockfile integrity; copy only its
// pinned optional native package. Never run dependency installation scripts.
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const wrapper = dirname(require.resolve('opencode-ai/package.json'));
const metadata = JSON.parse(await fs.readFile(join(wrapper, 'package.json'), 'utf8'));
if (metadata.version !== '1.19.3') throw new Error('Unexpected OpenCode version');
const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform];
if (!os || !['x64', 'arm64'].includes(process.arch)) throw new Error('Unsupported native platform');
const musl = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
const name = `opencode-${os}-${process.arch}${process.arch === 'x64' ? '-baseline' : ''}${musl ? '-musl' : ''}`;
if (metadata.optionalDependencies[name] !== metadata.version) throw new Error('Unpinned native binary');
const native = dirname(require.resolve(`${name}/package.json`));
const sourceMetadata = JSON.parse(await fs.readFile(join(native, 'package.json'), 'utf8'));
if (sourceMetadata.version !== metadata.version) throw new Error('Native package version differs');
await fs.mkdir(join(wrapper, 'bin'), { recursive: true });
await fs.copyFile(join(native, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'), join(wrapper, 'bin', 'opencode.exe'));
await fs.chmod(join(wrapper, 'bin', 'opencode.exe'), 0o755);
console.log(JSON.stringify({ status: 'prepared', version: metadata.version, lifecycleScripts: false, platform: process.platform }));

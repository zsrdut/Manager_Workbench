import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
let commit = process.env.VERCEL_GIT_COMMIT_SHA || '';
if (!commit) {
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { commit = 'uncommitted'; }
}
if (!/^(?:[0-9a-f]{40}|uncommitted)$/.test(commit)) throw new Error('Invalid build commit');
const pkg = JSON.parse(await readFile(new URL('package.json', import.meta.url), 'utf8'));
const html = await readFile(new URL('workbench.html', import.meta.url), 'utf8');
await mkdir(new URL('public/', import.meta.url), { recursive: true });
await writeFile(new URL('public/index.html', import.meta.url), html.replaceAll('__BUILD_COMMIT__', commit === 'uncommitted' ? '未提交本地版本' : commit.slice(0, 12)));
await writeFile(new URL('public/version.json', import.meta.url), JSON.stringify({ app: pkg.name, version: pkg.version, commit, storage: 'browser-local-only', demo: true }, null, 2));
console.log(`Built public/index.html and public/version.json (${commit})`);

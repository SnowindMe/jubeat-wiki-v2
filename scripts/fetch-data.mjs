// Pull the private data repo into the working tree before a build.
//
// The public repo carries source only: song data, constants, Jubility, unlock
// pools and jackets live in a separate PRIVATE repo so they are not published.
// Vercel therefore has to fetch them at build time.
//
//   DATA_REPO_TOKEN set   -> shallow-clone the private repo and sync the files
//   no token, data present-> skip (local development already has the data)
//   no token, data absent -> fail loudly instead of building an empty site
import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = 'SnowindMe/jubeat-wiki-data';
const token = process.env.DATA_REPO_TOKEN;
const staging = path.join(root, '.data-fetch');

const exists = async target => { try { await access(target); return true; } catch { return false; } };
const say = message => console.log(`[fetch-data] ${message}`);

if (!token) {
  if (await exists(path.join(root, 'data/songs.json'))) {
    say('DATA_REPO_TOKEN 未设置，但本地已有数据，跳过拉取。');
    process.exit(0);
  }
  console.error('[fetch-data] 缺少数据且未设置 DATA_REPO_TOKEN。');
  console.error('  本地开发：请先准备好 data/ 与 public/jackets/，或设置该变量后重试。');
  console.error('  CI/Vercel：请在项目环境变量中配置 DATA_REPO_TOKEN（私有仓库只读 PAT）。');
  process.exit(1);
}

// Never let the token reach a log: execFileSync would echo the URL on failure.
const remote = `https://x-access-token:${token}@github.com/${slug}.git`;
const redact = text => String(text).replaceAll(token, '***');

await rm(staging, { recursive: true, force: true });
say('正在拉取私有数据仓库…');
try {
  execFileSync('git', ['clone', '--depth', '1', '--quiet', remote, staging], { stdio: 'pipe' });
} catch (error) {
  console.error(`[fetch-data] 克隆失败：${redact(error.stderr || error.message)}`);
  console.error('  请确认 DATA_REPO_TOKEN 有效、未过期，且对该私有仓库有读取权限。');
  process.exit(1);
}

const dataSrc = path.join(staging, 'data');
const jacketSrc = path.join(staging, 'jackets');
const dataDest = path.join(root, 'data');
const jacketDest = path.join(root, 'public', 'jackets');

if (!(await exists(path.join(dataSrc, 'songs.json')))) {
  console.error('[fetch-data] 数据仓库里没有 data/songs.json，结构与预期不符。');
  process.exit(1);
}

await mkdir(dataDest, { recursive: true });
for (const file of ['songs.json', 'jubility.json', 'unlock.json', 'data-meta.json', 'data-conflicts.json', 'difficulty-index.json', 'audit-report.md']) {
  if (await exists(path.join(dataSrc, file))) await cp(path.join(dataSrc, file), path.join(dataDest, file));
}

// jackets are synced wholesale so removals upstream do not leave stale files
await rm(jacketDest, { recursive: true, force: true });
await mkdir(jacketDest, { recursive: true });
if (await exists(jacketSrc)) await cp(jacketSrc, jacketDest, { recursive: true });

// memo 谱面文本：同样整体同步，避免上游删除后本地残留。
// 这些文件是谱面预览器的输入（src/lib/memo-data.js 读取 data/memo/*.txt）。
// 缺失不是错误：没有谱面数据时预览器不渲染，站点其余部分照常工作。
const memoSrc = path.join(dataSrc, 'memo');
const memoDest = path.join(root, 'data', 'memo');
await rm(memoDest, { recursive: true, force: true });
let memoCount = 0;
if (await exists(memoSrc)) {
  await mkdir(memoDest, { recursive: true });
  await cp(memoSrc, memoDest, { recursive: true });
  memoCount = (await import('node:fs')).readdirSync(memoDest).filter((f) => f.endsWith('.txt')).length;
}

await rm(staging, { recursive: true, force: true });
const jackets = (await import('node:fs')).readdirSync(jacketDest).length;
say(`完成：data/ 已同步，public/jackets/ ${jackets} 个文件，memo 谱面 ${memoCount} 份。`);

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
import { cp, mkdir, rm, access, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const slug = 'SnowindMe/jubeat-wiki-data';
const token = process.env.DATA_REPO_TOKEN;
const staging = path.join(root, '.data-fetch');

const exists = async (target) => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};
const say = (message) => console.log(`[fetch-data] ${message}`);

if (!token) {
  if (await exists(path.join(root, 'data/songs.json'))) {
    say('DATA_REPO_TOKEN 未设置，但本地已有数据，跳过拉取。');
    await syncPublicIndex();
    process.exit(0);
  }
  console.error('[fetch-data] 缺少数据且未设置 DATA_REPO_TOKEN。');
  console.error('  本地开发：请先准备好 data/ 与 public/jackets/，或设置该变量后重试。');
  console.error('  CI/Vercel：请在项目环境变量中配置 DATA_REPO_TOKEN（私有仓库只读 PAT）。');
  process.exit(1);
}

// Never let the token reach a log: execFileSync would echo the URL on failure.
const remote = `https://x-access-token:${token}@github.com/${slug}.git`;
const redact = (text) => String(text).replaceAll(token, '***');

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

// mcz 索引（data/mcz/index.json）：songId -> CDN 上的 .mcz 地址。
// 构建期只需要它，不做任何谱面本体下载；浏览器在用户点预览时按需读取。
const mczSrc = path.join(dataSrc, 'mcz');
const mczDest = path.join(dataDest, 'mcz');
if (await exists(mczSrc)) {
  await rm(mczDest, { recursive: true, force: true });
  await mkdir(mczDest, { recursive: true });
  await cp(mczSrc, mczDest, { recursive: true });
}

await rm(staging, { recursive: true, force: true });

const jackets = (await readdir(jacketDest)).length;
let mczCount = 0;
if (await exists(path.join(mczDest, 'index.json'))) {
  try {
    const idx = JSON.parse((await import('node:fs')).readFileSync(path.join(mczDest, 'index.json'), 'utf8'));
    mczCount = Object.keys(idx).length;
  } catch {
    /* 索引损坏时不阻断构建，前端会回退到「无预览」 */
  }
}

// 前端需要索引才能按 songId 找到 CDN 地址，所以同时放到 public/ 下。
await syncPublicIndex();

say(`完成：data/ 已同步，public/jackets/ ${jackets} 个文件，mcz 索引 ${mczCount} 首。`);

/** 把 data/mcz/index.json 同步到 public/data/mcz/index.json（前端运行时读取） */
async function syncPublicIndex() {
  const src = path.join(root, 'data', 'mcz', 'index.json');
  const destDir = path.join(root, 'public', 'data', 'mcz');
  if (!(await exists(src))) return;
  await mkdir(destDir, { recursive: true });
  await cp(src, path.join(destDir, 'index.json'));

  // 全量清单：前端运行时用来给「构建期没匹配到谱面」的曲目兜底。
  // 构建期索引是精确匹配的快路径；清单让浏览器能自己判断仓库里到底有没有这首。
  // 字段精简成 d/n/s（目录 / 文件名 / 字节数），path 恒等于 dir + '/' + name，
  // CDN 前缀由前端拼，省掉每条 URL 里重复的一长串。
  const listSrc = path.join(root, 'data', 'mcz', '_list.json');
  if (!(await exists(listSrc))) return;
  try {
    const list = JSON.parse(await readFile(listSrc, 'utf8'));
    const slim = list.map((f) => ({ d: f.dir, n: f.name, s: f.size }));
    await writeFile(path.join(destDir, 'list.json'), JSON.stringify(slim), 'utf8');
  } catch (err) {
    say(`警告：生成 mcz 清单失败（${err.message}），前端将只用构建期索引。`);
  }
}

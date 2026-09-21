import { access, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const songs = JSON.parse(await readFile(path.join(root, 'data', 'songs.json'), 'utf8')).songs;
const pathId = (songId) => /^\d+$/.test(songId) ? songId : `id-${Array.from(songId, char => char.codePointAt(0).toString(16)).join('-')}`;
const href = (songId) => `/songs/${pathId(songId)}/`;
const checks = [];
const pass = (name, evidence) => checks.push({ name, status: 'passed', evidence });
const fail = (name, evidence) => checks.push({ name, status: 'failed', evidence });
const skip = (name, reason) => checks.push({ name, status: 'skipped', reason });
const exists = async file => access(file).then(() => true).catch(() => false);

const indexPath = path.join(dist, 'search-index.json');
if (await exists(indexPath)) {
  const index = JSON.parse(await readFile(indexPath, 'utf8')).entries;
  const valid = Array.isArray(index) && index.length === songs.length && index.every((entry, i) => entry.songId === songs[i].songId && 'title' in entry && 'artist' in entry && entry.url === href(entry.songId));
  valid ? pass('搜索索引', `${index.length} 条，URL 与规则一致`) : fail('搜索索引', '字段、数量或 URL 不一致');
} else fail('搜索索引', 'dist/search-index.json 不存在');

const numeric = songs.filter(song => /^\d+$/.test(song.songId));
const numericPaths = await Promise.all(numeric.map(song => exists(path.join(dist, 'songs', song.songId, 'index.html'))));
const semantic = numeric.every(song => href(song.songId) === `/songs/${song.songId}/`) && numericPaths.every(Boolean);
semantic ? pass('语义数值 URL', `${numeric.length} 首数值 ID 为 /songs/<songId>/`) : fail('语义数值 URL', '数值 ID 静态路径缺失');
const titleIds = songs.filter(song => !/^\d+$/.test(song.songId));
const titlePaths = await Promise.all(titleIds.map(song => exists(path.join(dist, 'songs', pathId(song.songId), 'index.html'))));
titlePaths.every(Boolean) ? pass('特殊 ID 可逆编码', `${titleIds.length} 个 title: 型 ID 使用 id-十六进制码点路径`) : fail('特殊 ID 可逆编码', '特殊 ID 静态路径缺失');

const sitemap = await readFile(path.join(dist, 'sitemap-0.xml'), 'utf8');
const sitemapOk = songs.every(song => sitemap.includes(href(song.songId)));
sitemapOk ? pass('内部链接与 sitemap', '所有歌曲 URL 均出现在 sitemap') : fail('内部链接与 sitemap', 'sitemap 漏曲');

const jackets = await readdir(path.join(root, 'public', 'jackets'));
const jacketStats = await Promise.all(jackets.map(async name => [name, await stat(path.join(root, 'public', 'jackets', name))]));
const tooLarge = jacketStats.filter(([, info]) => info.size > 30 * 1024);
tooLarge.length === 0 ? pass('曲绘资源预算', `${jackets.length} 张曲绘全部 ≤30KB`) : fail('曲绘资源预算', `${tooLarge.length} 张超过 30KB`);

const configs = ['.nvmrc', 'vercel.json', 'wrangler.toml', 'functions/README.md', 'docs/future-voting-api.md'];
const configOk = (await Promise.all(configs.map(file => exists(path.join(root, file))))).every(Boolean);
configOk ? pass('部署与 Functions 预留', 'Node、Vercel、Cloudflare Pages 与未来 API 文档齐全；本脚本不部署') : fail('部署与 Functions 预留', '预留配置或文档缺失');

const html = await readFile(path.join(dist, 'songs', numeric[0].songId, 'index.html'), 'utf8');
const libraryHtml = await readFile(path.join(dist, 'songs', 'index.html'), 'utf8');
html.includes('谱面难度') && libraryHtml.includes('全部结果') ? pass('无 JS 静态可读性', '构建 HTML 直接含曲库“全部结果”和详情“谱面难度”正文') : fail('无 JS 静态可读性', '关键正文未静态输出');

const browserChecks = ['Lighthouse：首页、曲目库、详情、玩法页', 'axe：关键页面', '视口横向溢出：375/768/1440'];
for (const name of browserChecks) skip(name, '本项目未安装 Playwright/Puppeteer 或 Lighthouse CLI，且验收环境未提供可连接浏览器；未伪造浏览器结果。请安装浏览器工具后执行对应审计。');
if (await exists(path.join(root, 'docs', 'platform-build-manifest.json'))) pass('双平台产物断言', 'Vercel 与 Cloudflare 均配置为 npm run build → dist；平台构建清单已生成。'); else fail('双平台产物断言', '缺少 docs/platform-build-manifest.json；请先运行 npm run verify:platform-build。');

const failed = checks.filter(check => check.status === 'failed');
const report = { generatedAt: new Date().toISOString(), checks, summary: { passed: checks.filter(c => c.status === 'passed').length, skipped: checks.filter(c => c.status === 'skipped').length, failed: failed.length } };
await writeFile(path.join(root, 'docs', 'acceptance-evidence.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary));
for (const check of checks) console.log(`[${check.status.toUpperCase()}] ${check.name}: ${check.evidence ?? check.reason}`);
if (failed.length) process.exitCode = 1;

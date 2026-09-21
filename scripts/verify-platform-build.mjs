import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))).flat();
};
for (const config of ['.nvmrc', 'vercel.json', 'wrangler.toml']) await stat(path.join(root, config));
const files = await walk(dist);
const manifest = {};
for (const file of files) manifest[path.relative(dist, file).replaceAll('\\', '/')] = createHash('sha256').update(await readFile(file)).digest('hex');
await writeFile(path.join(root, 'docs', 'platform-build-manifest.json'), JSON.stringify({ buildCommand: 'npm run build', outputDirectory: 'dist', node: (await readFile(path.join(root, '.nvmrc'), 'utf8')).trim(), files: manifest }, null, 2) + '\n');
console.log(`平台构建清单已生成：${files.length} 个 dist 文件；Vercel/Cloudflare Pages 均为 npm run build → dist。`);

import { readdir, stat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jackets = path.join(root, 'public', 'jackets');
const limit = 30 * 1024;
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const files = (await readdir(jackets)).filter(name => name.endsWith('.webp'));
let changed = 0;
for (const name of files) {
  const input = path.join(jackets, name);
  if ((await stat(input)).size <= limit) continue;
  const temp = `${input}.tmp.webp`;
  let success = false;
  for (const [quality, scale] of [[72, null], [62, null], [52, null], [42, null], [55, 256], [45, 256], [45, 192]]) {
    const args = ['-y', '-i', input];
    if (scale) args.push('-vf', `scale='min(${scale},iw)':-2`);
    args.push('-c:v', 'libwebp', '-q:v', String(quality), '-compression_level', '6', temp);
    const run = spawnSync(ffmpeg, args, { stdio: 'pipe' });
    if (run.status === 0 && (await stat(temp)).size <= limit) { success = true; break; }
  }
  if (!success) { await unlink(temp).catch(() => {}); throw new Error(`无法将 ${name} 压缩到 ${limit} 字节以内`); }
  await rename(temp, input); changed++;
}
console.log(`曲绘压缩完成：检查 ${files.length} 张，重新编码 ${changed} 张，单文件上限 ${limit} 字节。`);

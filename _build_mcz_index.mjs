// 生成前端用的 mcz 索引：曲目 songId -> mcz 路径
// 构建时产出静态 JSON，前端按 songId 查
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const songs = JSON.parse(readFileSync('data/songs.json', 'utf8')).songs;
const list = JSON.parse(readFileSync('data/mcz/_list.json', 'utf8'));

/** 归一化：全角转半角、去空白、去标点、小写 */
const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');

/** 文件名清洗：去掉 README 里提到的「特殊字符替换」痕迹（如 __ 表示被替换的字符） */
const cleanFile = (name) =>
  name
    .replace(/\.mcz$/i, '')
    .replace(/_{2,}/g, '')      // "Go Beyond__" 这类下划线占位
    .replace(/\s*\[\s*\d+\s*\]/g, '') // "[ 2 ]" 这类第二谱面标记
    .trim();

const songByNorm = new Map();
for (const s of songs) {
  const k = norm(s.title);
  if (!songByNorm.has(k)) songByNorm.set(k, s);
}

// 一轮：精确匹配
const bySongId = new Map();
const leftovers = [];
for (const f of list) {
  const base = cleanFile(f.name);
  const song = songByNorm.get(norm(base));
  if (song) {
    if (!bySongId.has(song.songId)) bySongId.set(song.songId, []);
    bySongId.get(song.songId).push(f);
  } else {
    leftovers.push(f);
  }
}
const exactCount = bySongId.size;

// 二轮：对剩余文件做「包含」匹配（曲库名被 mcz 名包含，或反之）
for (const f of leftovers) {
  const base = norm(cleanFile(f.name));
  if (base.length < 3) continue;
  let hit = null;
  for (const [k, s] of songByNorm) {
    if (bySongId.has(s.songId)) continue;
    if (k.length >= 3 && (k === base || base.startsWith(k) || k.startsWith(base))) { hit = s; break; }
  }
  if (hit) {
    if (!bySongId.has(hit.songId)) bySongId.set(hit.songId, []);
    bySongId.get(hit.songId).push(f);
  }
}

console.log(`曲库 ${songs.length} 首`);
console.log(`  一轮精确匹配曲目 = ${exactCount}`);
console.log(`  二轮包含匹配后   = ${bySongId.size}`);

// 生成索引：每首曲取文件最大的 mcz（内容最全）
const REPO = 'SnowindMe/Jubeat2Malody-GUI';
const BRANCH = 'mcz-releases';
const index = {};
for (const [songId, files] of bySongId) {
  const pick = files.slice().sort((a, b) => b.size - a.size)[0];
  index[songId] = {
    dir: pick.dir,
    file: pick.name,
    path: pick.path,
    size: pick.size,
    url: `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/${encodeURI(pick.path)}`,
  };
}

mkdirSync('data/mcz', { recursive: true });
writeFileSync('data/mcz/index.json', JSON.stringify(index, null, 1), 'utf8');
console.log(`\n-> data/mcz/index.json（${Object.keys(index).length} 条）`);

// 未匹配的曲目
const miss = songs.filter((s) => !index[s.songId]);
console.log(`\n无谱面的曲目 = ${miss.length}`);
console.log('样例:', JSON.stringify(miss.slice(0, 10).map((s) => s.title)));

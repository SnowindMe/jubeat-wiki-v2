// 生成前端用的 mcz 索引：曲目 songId -> mcz 路径
// 构建时产出静态 JSON，前端按 songId 查（前端另有运行期兜底，见 src/lib/mcz-match.js）
//
// 匹配规则全部来自 src/lib/mcz-match.js —— 与浏览器端共用同一套归一化，
// 保证「页面有没有按钮」和「点开后能不能找到谱面」不会出现两种答案。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  MCZ_CDN_BASE,
  TIER_RANK,
  normTitle,
  stripMczExt,
  dropAltMark,
  isAltChart,
  compareCandidates,
} from './src/lib/mcz-match.js';

const songs = JSON.parse(readFileSync('data/songs.json', 'utf8')).songs;
const list = JSON.parse(readFileSync('data/mcz/_list.json', 'utf8'));

const songByNorm = new Map();
for (const s of songs) {
  const k = normTitle(s.title);
  if (!songByNorm.has(k)) songByNorm.set(k, s);
}

const candidates = new Map(); // songId -> [{ file, tier }]
const addCandidate = (songId, file, tier) => {
  if (!candidates.has(songId)) candidates.set(songId, []);
  candidates.get(songId).push({ file, tier });
};

// 一轮：原样匹配（保留 [ N ] 标记）。
// 曲库里的 `robin [2]` 是独立曲目，必须与 `Robin [ 2 ].mcz` 对上号；
// 若先把 [ N ] 抹掉，第二谱面就会被塞给同名主曲目，预览内容直接是错的。
const leftovers = [];
for (const f of list) {
  const song = songByNorm.get(normTitle(stripMczExt(f.name)));
  if (song) addCandidate(song.songId, f, 'exact');
  else leftovers.push(f);
}
const exactCount = candidates.size;

// 二轮：抹掉 [ N ] 后再匹配，作为兜底。
// 这些文件优先级低于 exact，永远不会顶替主谱面。
for (const f of leftovers) {
  const base = normTitle(dropAltMark(stripMczExt(f.name)));
  if (base.length < 3) continue;
  const song = songByNorm.get(base);
  if (song) addCandidate(song.songId, f, 'alt');
}

// 三轮：对仍未匹配的文件做「包含」匹配（曲名互为前缀/包含关系）
for (const f of leftovers) {
  const base = normTitle(dropAltMark(stripMczExt(f.name)));
  if (base.length < 3) continue;
  let hit = null;
  for (const [k, s] of songByNorm) {
    if (candidates.has(s.songId)) continue;
    if (k.length >= 3 && (k === base || base.startsWith(k) || k.startsWith(base))) {
      hit = s;
      break;
    }
  }
  if (hit) addCandidate(hit.songId, f, 'loose');
}
const total = candidates.size;

console.log(`曲库 ${songs.length} 首`);
console.log(`  一轮原样匹配曲目 = ${exactCount}`);
console.log(`  兜底+包含匹配后   = ${total}`);

// 生成索引：每首曲取最合适的 mcz
const index = {};
for (const [songId, entries] of candidates) {
  // 排序优先：匹配档位 -> 非第二谱面 -> 体积大者
  const pick = entries
    .slice()
    .sort((a, b) =>
      compareCandidates(
        { tier: a.tier, name: a.file.name, size: a.file.size },
        { tier: b.tier, name: b.file.name, size: b.file.size },
      ),
    )[0].file;
  index[songId] = {
    dir: pick.dir,
    file: pick.name,
    path: pick.path,
    size: pick.size,
    tier: entries.slice().sort((a, b) =>
      compareCandidates(
        { tier: a.tier, name: a.file.name, size: a.file.size },
        { tier: b.tier, name: b.file.name, size: b.file.size },
      ),
    )[0].tier,
    url: MCZ_CDN_BASE + encodeURI(pick.path),
  };
}

mkdirSync('data/mcz', { recursive: true });
writeFileSync('data/mcz/index.json', JSON.stringify(index, null, 1), 'utf8');
console.log(`\n-> data/mcz/index.json（${Object.keys(index).length} 条）`);

// 未匹配的曲目
const miss = songs.filter((s) => !index[s.songId]);
console.log(`\n无谱面的曲目 = ${miss.length}`);
console.log('样例:', JSON.stringify(miss.slice(0, 10).map((s) => s.title)));

// 档位分布，便于回归时快速发现匹配质量变化
const tierDist = {};
for (const id of Object.keys(index)) {
  const t = index[id].tier;
  tierDist[t] = (tierDist[t] ?? 0) + 1;
}
console.log('档位分布:', JSON.stringify(tierDist));

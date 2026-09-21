import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = async (name) => JSON.parse(await readFile(path.join(root, 'data', name), 'utf8'));
const required = ['songs.json', 'difficulty-index.json', 'jubility.json', 'unlock.json', 'data-meta.json'];
const fail = (message) => { throw new Error(message); };

for (const name of required) await access(path.join(root, 'data', name));
const [songsFile, index, jubility, unlock, meta] = await Promise.all(required.map(data));
const songs = songsFile.songs;
if (!Array.isArray(songs) || songs.length === 0) fail('songs.json 必须含非空 songs 数组');
const ids = new Set();
const indexKeys = new Set();
const validDiffs = new Set(['bsc', 'adv', 'ext']);
for (const song of songs) {
  if (!song.songId || typeof song.songId !== 'string' || ids.has(song.songId)) fail(`songId 非法或重复：${song.songId}`);
  ids.add(song.songId);
  for (const key of ['artist', 'bpm', 'cover', 'unlockPool', 'poolPhase', 'exchangeCost', 'addedAt', 'addedBatch', 'notecounts', 'songConnections']) if (!(key in song)) fail(`${song.songId} 缺少 ${key}`);
  if (!Array.isArray(song.sources) || !song.sources.length) fail(`${song.songId} 缺少来源`);
  if (song.hasRemywiki !== (song.sources.includes('remywiki'))) fail(`${song.songId} hasRemywiki 与 remywiki 来源不一致`);
  for (const diff of validDiffs) if (song.levels[diff] !== null) indexKeys.add(`${song.songId}:${diff}`);
}
if (!Array.isArray(index) || index.length !== indexKeys.size) fail('difficulty-index 条数与 songs 难度值不一致');
for (const entry of index) {
  if (!validDiffs.has(entry.diff) || entry.difficultyKey !== `${entry.songId}:${entry.diff}` || !ids.has(entry.songId) || !indexKeys.has(entry.difficultyKey)) fail(`无效 difficultyKey：${JSON.stringify(entry)}`);
}
for (const entry of jubility.entries) {
  if (!ids.has(entry.songId) || !indexKeys.has(entry.difficultyKey) || entry.difficultyKey !== `${entry.songId}:${({ Basic: 'bsc', Advanced: 'adv', Extreme: 'ext' })[entry.diff]}`) fail(`Jubility 条目无法解析：${entry.title}`);
  for (const key of ['constant', 'excClass', 'valueNormal', 'valueHard']) if (!(key in entry)) fail(`Jubility 缺少 ${key}`);
}
if (!unlock.pools || !Array.isArray(unlock.poolsUnmatched) || unlock.poolActualTotal !== 179 || unlock.poolRawTotal !== 185) fail('unlock 双轨池统计缺失或不符');
for (const [pool, data] of Object.entries(unlock.pools)) for (const item of [...data.phase1, ...data.phase2]) if (item.songId !== null && !ids.has(item.songId)) fail(`${pool} 包含未知曲目 ${item.title}`);
if (!Array.isArray(meta.sources) || !meta.sources.length || meta.sources.some((source) => !/^[a-f0-9]{64}$/.test(source.sha256))) fail('data-meta 缺少有效源哈希');
if (!meta.missing || !meta.missingRecords || meta.buildMode !== 'offline') fail('data-meta 缺少缺口统计、可回溯记录或离线构建标记');
const covers = await readdir(path.join(root, 'public', 'jackets'));
if (covers.length !== meta.counts.jackets) fail(`曲绘数量不符：${covers.length}/${meta.counts.jackets}`);
console.log(`数据校验通过：${songs.length} 首曲目、${index.length} 个难度键、${jubility.entries.length} 条 Jubility、${covers.length} 张曲绘。`);

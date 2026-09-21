import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const workspace = path.resolve(root, '..');
const oldRoot = path.join(workspace, 'jubeat-wiki');
const dataDir = path.join(root, 'data');
const jacketsDir = path.join(root, 'public', 'jackets');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const output = async (name, value) => writeFile(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);

const [oldSongs, oldMeta, coverMap, auditSummary, auditCovers] = await Promise.all([
  json(path.join(oldRoot, 'data', 'songs.json')),
  json(path.join(oldRoot, 'data', 'wiki-meta.json')),
  json(path.join(oldRoot, 'data', 'cover-map.json')),
  json(path.join(dataDir, '_audit', 'out', 'summary.json')),
  json(path.join(dataDir, '_audit', 'out', 'gaps-covers.json')),
]);

const sourceFiles = [
  ['legacySongs', path.join(oldRoot, 'data', 'songs.json'), 'S1/S2/S3/S5/S6/S7 聚合历史快照', null],
  ['legacyMeta', path.join(oldRoot, 'data', 'wiki-meta.json'), 'S3/S6/S7 聚合历史快照', null],
  ['coverMap', path.join(oldRoot, 'data', 'cover-map.json'), 'S8 曲绘映射', null],
  ['auditSummary', path.join(dataDir, '_audit', 'out', 'summary.json'), '本轮审计汇总', null],
  ['auditCovers', path.join(dataDir, '_audit', 'out', 'gaps-covers.json'), '本轮无曲绘缺口清单', null],
];
const sources = await Promise.all(sourceFiles.map(async ([id, file, description, url]) => ({
  id, path: path.relative(workspace, file).replaceAll('\\', '/'), sha256: await sha256(file), url, description,
})));

const normalizeMarks = () => ({ bsc: null, adv: null, ext: null });
const sourceFor = (legacy) => [...new Set((legacy.sources || []).filter(Boolean).map((value) => value === 'all_songs' ? 'official-catalog' : value))];
const songs = oldSongs.songs.map((legacy) => {
  const remywiki = legacy.remywiki ?? null;
  const cover = legacy.cover ? `/jackets/${path.basename(legacy.cover)}` : null;
  const levels = { bsc: legacy.levels?.bsc ?? null, adv: legacy.levels?.adv ?? null, ext: legacy.levels?.ext ?? null };
  const sources = sourceFor(legacy);
  if (remywiki && !sources.includes('remywiki')) sources.push('remywiki');
  if (!remywiki) { const index = sources.indexOf('remywiki'); if (index !== -1) sources.splice(index, 1); }
  return {
    songId: String(legacy.id), title: legacy.title, titleNorm: legacy.titleNorm,
    artist: legacy.artist ?? null, bpm: legacy.bpm == null ? null : String(legacy.bpm), levels,
    levelMarks: normalizeMarks(), chartCount: Object.values(levels).filter((value) => value !== null).length,
    hasAltChart: Boolean(legacy.hasAltChart || remywiki?.altCharts), origin: legacy.origin ?? '原机种待考',
    category: legacy.category ?? 'old', isPickUp: Boolean(legacy.isPickUp), limited: Boolean(legacy.limited),
    unlockPool: legacy.unlockPool ?? null, poolPhase: legacy.poolPhase ?? null,
    exchangeCost: legacy.exchangeCost ?? null, addedAt: legacy.addedAt ?? null, addedBatch: legacy.addedBatch ?? null,
    cover, notecounts: remywiki?.notecounts ?? null, levelHistory: remywiki?.levelHistory ?? [],
    trivia: remywiki?.trivia ?? [], songConnections: remywiki?.songConnections ?? null,
    hasRemywiki: remywiki !== null, sources,
    fieldSources: {
      title: 'official-catalog', artist: legacy.artist == null ? null : 'official-catalog', bpm: legacy.bpm == null ? null : 'official-catalog',
      bsc: levels.bsc == null ? null : 'api', adv: levels.adv == null ? null : 'remywiki', ext: levels.ext == null ? null : 'remywiki',
      cover: cover == null ? null : 'cover-map', origin: sources.includes('origin-patch') ? 'origin-patch' : 'remywiki',
    },
  };
});

const difficultyIndex = songs.flatMap((song) => ['bsc', 'adv', 'ext'].filter((diff) => song.levels[diff] !== null).map((diff) => ({
  difficultyKey: `${song.songId}:${diff}`, songId: song.songId, diff, title: song.title, constant: song.levels[diff],
})));
const byId = new Map(songs.map((song) => [song.songId, song]));
const legacyJubility = oldMeta.jubility?.entries ?? [];
const diffMap = { Basic: 'bsc', Advanced: 'adv', Advance: 'adv', Extreme: 'ext' };
const jubilityEntries = legacyJubility.map((entry) => {
  const songId = String(entry.songId); const diff = diffMap[entry.diff]; const song = byId.get(songId);
  return { title: entry.title, diff: entry.diff === 'Advance' ? 'Advanced' : entry.diff, constant: entry.constant ?? null,
    excClass: entry.excClass ?? null, valueNormal: entry.valueNormal ?? null, valueHard: entry.valueHard ?? null,
    section: entry.section, source: entry.source, songId, difficultyKey: `${songId}:${diff}`,
    hasAltChart: Boolean(entry.hasAltChart), titleStripped: entry.titleStripped ?? null, resolvedAs: entry.resolvedAs ?? null, titleSource: song?.title ?? null };
});
const numericMax = (field) => Math.max(...jubilityEntries.map((entry) => entry[field]).filter(Number.isFinite));
const jubility = { updatedAt: oldMeta.jubility?.updatedAt ?? null, source: oldMeta.jubility?.source ?? null, entries: jubilityEntries, maxNormal: numericMax('valueNormal'), maxHard: numericMax('valueHard') };

const poolNames = ['CHERRY', 'KUMQUAT', 'LIME', 'BLUEBERRY', 'RAINBOW'];
const legacyPools = oldMeta.pools ?? {};
const titleToSongs = new Map();
for (const song of songs) { const list = titleToSongs.get(song.titleNorm) ?? []; list.push(song); titleToSongs.set(song.titleNorm, list); }
const norm = (title) => String(title).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const unmatched = [];
const pools = Object.fromEntries(poolNames.map((name) => {
  const pool = legacyPools[name] ?? {};
  const resolve = (title, phase) => { const found = titleToSongs.get(norm(title)) ?? []; if (!found.length) unmatched.push({ pool: name, phase, title, reason: 'no-independent-song-object', source: 'remywiki.index' }); return found[0]?.songId ?? null; };
  return [name, { phase1: (pool.phase1 ?? []).map((title) => ({ title, songId: resolve(title, 1) })), phase2: (pool.phase2 ?? []).map((title) => ({ title, songId: resolve(title, 2) })), phase1Window: pool.phase1Window ?? null, phase2Note: pool.phase2Note ?? null, phase2Detail: pool.phase2Detail ?? null }];
}));
const unlock = { pools, poolsUnmatched: unmatched, poolCounts: oldMeta.statsOverview?.poolCounts ?? {}, poolRawCounts: oldMeta.statsOverview?.poolRawCounts ?? {}, poolRawTotal: oldMeta.statsOverview?.poolRawTotal ?? null, poolActualTotal: oldMeta.statsOverview?.poolActualTotal ?? null, source: 'remywiki.index', sourceHash: sources.find((item) => item.id === 'legacyMeta').sha256 };

await rm(jacketsDir, { recursive: true, force: true }); await mkdir(jacketsDir, { recursive: true });
for (const relative of Object.values(coverMap.bySongId)) await cp(path.join(oldRoot, 'public', relative), path.join(jacketsDir, path.basename(relative)));
const missing = {
  cover: songs.filter((song) => song.cover === null).map((song) => ({ songId: song.songId, title: song.title, source: 'data/_audit/out/gaps-covers.json' })),
  bpm: songs.filter((song) => song.bpm === null).map((song) => ({ songId: song.songId, title: song.title })),
  remywiki: songs.filter((song) => !song.hasRemywiki).map((song) => ({ songId: song.songId, title: song.title, source: 'remywiki.index' })),
  incompleteCharts: songs.filter((song) => song.chartCount < 3).map((song) => ({ songId: song.songId, title: song.title, levels: song.levels })),
};
const dataMeta = { schemaVersion: 2, generatedAt: oldSongs.generatedAt, buildMode: 'offline', sources,
  counts: { songs: songs.length, difficultyIndex: difficultyIndex.length, jubilityEntries: jubilityEntries.length, jackets: new Set(Object.values(coverMap.bySongId).map((value) => path.basename(value))).size, jacketMappings: Object.keys(coverMap.bySongId).length, unlockPools: poolNames.length, poolUnmatched: unmatched.length },
  missing: { covers: missing.cover.length, bpm: missing.bpm.length, remywiki: missing.remywiki.length, incompleteCharts: missing.incompleteCharts.length },
  missingRecords: missing, audit: { summary: 'data/_audit/out/summary.json', coverGaps: 'data/_audit/out/gaps-covers.json', coverGapAuditCount: auditCovers.count ?? auditCovers.gaps?.length ?? null, auditSummary },
  provenancePolicy: 'null 表示源数据缺失；fieldSources 与 sources 记录字段/曲目来源；构建过程不联网。' };
await Promise.all([output('songs.json', { schemaVersion: 2, generatedAt: oldSongs.generatedAt, songs }), output('difficulty-index.json', difficultyIndex), output('jubility.json', jubility), output('unlock.json', unlock), output('data-meta.json', dataMeta)]);
console.log(`Generated ${songs.length} songs, ${difficultyIndex.length} difficulty keys, ${jubilityEntries.length} jubility entries, ${Object.keys(coverMap.bySongId).length} jacket mappings.`);

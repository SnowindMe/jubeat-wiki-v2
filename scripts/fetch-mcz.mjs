// 抓取指定曲目的 mcz（通过 Range 只取谱面 + 音频），产出前端可用数据
// 用法: node scripts/fetch-mcz.mjs "jubeat-prop/天空の華.mcz"
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { parseMc, diffFromVersion, beatToSeconds } from '../src/lib/mc-parser.js';

const REPO = 'SnowindMe/Jubeat2Malody-GUI';
const BRANCH = 'mcz-releases';

// 产物一律落在被 .gitignore 覆盖的目录里。
// 音频与曲绘是第三方受版权保护数据，绝不能进 public/ —— 那会被 Astro 原样
// 拷进 dist/ 并部署到线上（本项目是公开站）。预览器本身从 CDN 直读 .mcz，
// 并不需要这些文件，它们只是离线抓取时的对照产物。
const CHART_OUT = 'data/chart';
const AUDIO_OUT = 'data/chart-assets/audio';
const COVER_OUT = 'data/chart-assets/cover';
mkdirSync(CHART_OUT, { recursive: true });
mkdirSync(AUDIO_OUT, { recursive: true });
mkdirSync(COVER_OUT, { recursive: true });

/** 读取远端 zip 条目表 */
async function readEntries(url) {
  const r1 = await fetch(url, { headers: { Range: 'bytes=-65536' } });
  if (!r1.ok) throw new Error('HTTP ' + r1.status);
  const tail = new Uint8Array(await r1.arrayBuffer());
  const cr = r1.headers.get('content-range') || '';
  const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+)/);
  const tailStart = m ? +m[1] : 0;

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('未找到 EOCD');
  const dv = new DataView(tail.buffer, tail.byteOffset + eocd);
  const cdSize = dv.getUint32(12, true), cdOffset = dv.getUint32(16, true);

  let cd;
  if (cdOffset >= tailStart && cdOffset + cdSize <= tailStart + tail.length) {
    cd = tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize);
  } else {
    const r2 = await fetch(url, { headers: { Range: `bytes=${cdOffset}-${cdOffset + cdSize - 1}` } });
    cd = new Uint8Array(await r2.arrayBuffer());
  }

  const cdv = new DataView(cd.buffer, cd.byteOffset);
  const entries = [];
  let off = 0;
  while (off < cd.length && cdv.getUint32(off, true) === 0x02014b50) {
    const nameLen = cdv.getUint16(off + 28, true);
    const extraLen = cdv.getUint16(off + 30, true);
    const commentLen = cdv.getUint16(off + 32, true);
    entries.push({
      name: new TextDecoder().decode(cd.subarray(off + 46, off + 46 + nameLen)),
      compMethod: cdv.getUint16(off + 10, true),
      compSize: cdv.getUint32(off + 20, true),
      uncompSize: cdv.getUint32(off + 24, true),
      localOffset: cdv.getUint32(off + 42, true),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 取条目并解压 */
async function readEntry(url, e) {
  const r0 = await fetch(url, { headers: { Range: `bytes=${e.localOffset}-${e.localOffset + 29}` } });
  const lh = new DataView(await r0.arrayBuffer());
  const dataStart = e.localOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  const r1 = await fetch(url, { headers: { Range: `bytes=${dataStart}-${dataStart + e.compSize - 1}` } });
  if (!r1.ok) throw new Error('取条目失败 ' + e.name + ' HTTP ' + r1.status);
  const raw = Buffer.from(await r1.arrayBuffer());
  return e.compMethod === 8 ? inflateRawSync(raw) : raw;
}

const targets = process.argv.slice(2);
if (!targets.length) {
  console.log('用法: node scripts/fetch-mcz.mjs "jubeat-prop/天空の華.mcz" [...]');
  process.exit(0);
}

for (const t of targets) {
  const url = `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/${encodeURI(t)}`;
  console.log(`\n=== ${t}`);
  try {
    const entries = await readEntries(url);
    console.log('  条目:', entries.map((e) => e.name.split('/').pop() + '(' + e.uncompSize + ')').join(' '));

    const mcEntries = entries.filter((e) => e.name.endsWith('.mc'));
    const audioEntry = entries.find((e) => /\.(ogg|mp3)$/i.test(e.name));
    const coverEntry = entries.find((e) => /\.(png|jpg|jpeg)$/i.test(e.name));

    // 音频落到 data/chart-assets（本地对照用，不进 public、不进仓库）
    let audioPath = null;
    if (audioEntry) {
      const base = path.basename(t).replace(/\.mcz$/i, '');
      const safe = base.replace(/[\\/:*?"<>|]/g, '_');
      const buf = await readEntry(url, audioEntry);
      writeFileSync(path.join(AUDIO_OUT, safe + '.ogg'), buf);
      audioPath = `chart-assets/audio/${safe}.ogg`;
      console.log(`  音频 -> ${audioPath}  (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
    }

    // 曲绘
    let coverPath = null;
    if (coverEntry) {
      const base = path.basename(t).replace(/\.mcz$/i, '');
      const safe = base.replace(/[\\/:*?"<>|]/g, '_');
      const buf = await readEntry(url, coverEntry);
      writeFileSync(path.join(COVER_OUT, safe + '.png'), buf);
      coverPath = `chart-assets/cover/${safe}.png`;
      console.log(`  曲绘 -> ${coverPath}  (${(buf.length / 1024).toFixed(0)} KB)`);
    }

    for (const e of mcEntries) {
      const text = (await readEntry(url, e)).toString('utf8');
      const p = parseMc(text);
      const diff = (diffFromVersion(p.meta.version) || '').toLowerCase();
      if (!diff) continue;
      const chart = {
        schema: 2,
        song: p.meta.title,
        difficulty: diff,
        level: p.meta.level,
        source: 'mcz',
        mcz: t,
        bpm: p.bpms[0]?.bpm ?? null,
        noteCount: p.stats.noteCount,
        holdCount: p.stats.holdCount,
        // .mc 的 index/endindex 是 0-based（实测 0..15），渲染端按 1..16 取面板格，统一 +1
        taps: p.notes.map((n) => ({ key: n.key + 1, t: +beatToSeconds(p.bpms, n.beat).toFixed(4) })),
        holds: p.holds.map((h) => ({
          key: h.key + 1,
          endKey: h.endKey != null ? h.endKey + 1 : h.key + 1,
          t: +beatToSeconds(p.bpms, h.startBeat).toFixed(4),
          endT: +beatToSeconds(p.bpms, h.endBeat).toFixed(4),
        })),
        audio: audioPath,
        cover: coverPath,
      };
      const fn = `${p.meta.title}-${diff}.json`.replace(/[\\/:*?"<>|]/g, '_');
      writeFileSync(path.join(CHART_OUT, fn), JSON.stringify(chart, null, 1), 'utf8');
      console.log(`  ${diff.toUpperCase()} 音符=${chart.taps.length} 长押=${chart.holds.length} -> data/chart/${fn}`);
    }
  } catch (err) {
    console.error('  失败: ' + err.message);
    process.exitCode = 1;
  }
}

// 用 Git Trees API 一次性列出 mcz-releases 分支的全部 .mcz 文件
const REPO = 'SnowindMe/Jubeat2Malody-GUI';
const BRANCH = 'mcz-releases';

const res = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`, {
  headers: { 'User-Agent': 'jubeat-wiki-builder' },
});
if (!res.ok) {
  console.log('HTTP', res.status, await res.text());
  process.exit(1);
}
const tree = (await res.json()).tree;
const mcz = tree.filter((e) => e.type === 'blob' && e.path.toLowerCase().endsWith('.mcz'));
console.log(`共 ${mcz.length} 个 .mcz`);

const byDir = {};
let totalBytes = 0;
for (const f of mcz) {
  const dir = f.path.split('/')[0];
  byDir[dir] = (byDir[dir] || 0) + 1;
  totalBytes += f.size || 0;
}
console.log('\n按目录:');
for (const [d, n] of Object.entries(byDir).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${d.padEnd(28)} ${n}`);
}
console.log(`\n总体积 = ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);

// 保存清单（含下载 URL 与大小），供批量抓取用
const { writeFileSync, mkdirSync } = await import('node:fs');
mkdirSync('data/mcz', { recursive: true });
const list = mcz.map((f) => ({
  dir: f.path.split('/')[0],
  name: f.path.split('/').pop(),
  path: f.path,
  size: f.size,
  url: `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/${encodeURI(f.path)}`,
}));
writeFileSync('data/mcz/_list.json', JSON.stringify(list, null, 1), 'utf8');
console.log('-> data/mcz/_list.json');

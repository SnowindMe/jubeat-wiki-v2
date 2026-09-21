// 谱面文件名 ↔ 曲目标题 的匹配规则（构建期与浏览器运行期共用）
//
// 为什么共用：页面上的「预览」按钮由构建期索引决定，而浏览器在没有索引条目时
// 还要拿同一份清单再兜底找一次。两套算法若各写一份，迟早会漂移成
// 「按钮说有、点开找不到」。所有归一化与优先级只在这一个文件里定义。
//
// 纯函数 + 常量，不 import 任何 Node 内置模块，浏览器与脚本都能用。

/** 谱面仓库（owner/repo） */
export const MCZ_REPO = 'SnowindMe/Jubeat2Malody-GUI';
/** 谱面仓库分支 */
export const MCZ_BRANCH = 'mcz-releases';
/** 谱面 CDN 前缀 */
export const MCZ_CDN_BASE = `https://cdn.jsdelivr.net/gh/${MCZ_REPO}@${MCZ_BRANCH}/`;

/** 匹配档位：数值越小越可信 */
export const TIER_RANK = { exact: 0, alt: 1, loose: 2 };

/** 归一化：全角转半角、去空白、去标点、小写 */
export function normTitle(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * 文件名清洗：去掉扩展名，并抹掉「非法字符被替换」留下的连续下划线。
 * 例：`Dash Dash Groovy Rush___.mcz`（原曲名 `Dash Dash Groovy Rush!!!`）
 */
export function stripMczExt(name) {
  return String(name ?? '')
    .replace(/\.mcz$/i, '')
    .replace(/_{2,}/g, '')
    .trim();
}

/** 去掉结尾的 `[ N ]` 第二谱面标记（仅作兜底，不能用来顶替主谱面） */
export function dropAltMark(base) {
  return String(base ?? '')
    .replace(/\s*\[\s*\d+\s*\]/g, '')
    .trim();
}

/** 是否为「第二谱面」文件（形如 `robin [ 2 ].mcz`） */
export function isAltChart(name) {
  return /\[\s*\d+\s*\]/.test(String(name ?? ''));
}

/**
 * 某文件名相对某曲目标题的匹配档位。
 * @returns {'exact'|'alt'|'loose'|null}
 */
export function tierForName(title, fileName) {
  const key = normTitle(title);
  if (!key) return null;
  const base = stripMczExt(fileName);

  // 1) 原样匹配：保留 [ N ] 标记。
  //    曲库里的 `robin [2]` 是独立曲目，必须对上 `Robin [ 2 ].mcz`；
  //    若先把 [ N ] 抹掉，第二谱面会被塞给同名主曲目，预览内容直接是错的。
  if (normTitle(base) === key) return 'exact';

  // 2) 抹掉 [ N ] 后再试，优先级低于 exact（永不顶替主谱面）
  const stripped = normTitle(dropAltMark(base));
  if (stripped.length >= 3 && stripped === key) return 'alt';

  // 3) 包含匹配：前缀/包含关系，且两边都够长（防单字母噪声）
  if (base.length >= 3 && key.length >= 3) {
    const b = normTitle(base);
    if (b === key || b.startsWith(key) || key.startsWith(b)) {
      if (Math.min(b.length, key.length) >= 3) return 'loose';
    }
  }
  return null;
}

/** 候选排序：档位 → 非第二谱面优先 → 体积大者优先 */
export function compareCandidates(a, b) {
  if (TIER_RANK[a.tier] !== TIER_RANK[b.tier]) return TIER_RANK[a.tier] - TIER_RANK[b.tier];
  const aa = isAltChart(a.name) ? 1 : 0;
  const bb = isAltChart(b.name) ? 1 : 0;
  if (aa !== bb) return aa - bb;
  return (b.size ?? 0) - (a.size ?? 0);
}

/** 清单条目（{d,n,s} 或 {dir,name,size,path}）→ CDN 地址 */
export function mczUrlFor(entry) {
  const dir = entry.d ?? entry.dir ?? '';
  const name = entry.n ?? entry.name ?? '';
  const rel = entry.p ?? entry.path ?? (dir ? `${dir}/${name}` : name);
  return MCZ_CDN_BASE + encodeURI(rel);
}

/**
 * 在清单里为某首曲子找最合适的 .mcz。
 * @param {Array<{d:string,n:string,s:number}>} list 全量清单
 * @param {string} title 曲目标题
 * @param {{exclude?: Set<string>}} [opts] exclude：已被占用的相对路径，避免抢别人的谱面
 * @returns {{entry:object, tier:string, url:string}|null}
 */
export function findMczForTitle(list, title, opts = {}) {
  const exclude = opts.exclude;
  let best = null;
  for (const entry of list) {
    if (exclude && exclude.has(`${entry.d}/${entry.n}`)) continue;
    const tier = tierForName(title, entry.n);
    if (!tier) continue;
    const cand = { entry, tier, name: entry.n, size: entry.s };
    if (!best || compareCandidates(cand, best) < 0) best = cand;
  }
  if (!best) return null;
  return { entry: best.entry, tier: best.tier, url: mczUrlFor(best.entry) };
}

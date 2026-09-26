import type { GroupDTO } from '../api/types';

/** 统一成可比较的形式：全角→半角、小写、去掉空格和常见标点 */
function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s()（）[\]【】{}<>《》\-_.,，。·、:：;；!！?？'"“”‘’/\\|~`@#$%^&*+=]/g, '');
}

/**
 * 关键词 q 在 text 里的匹配得分，越小越好；不匹配返回 null。
 * 连续出现（子串）最好；否则只要字符按顺序出现就算匹配，字符越分散得分越差。
 */
function matchScore(text: string, q: string): number | null {
  const idx = text.indexOf(q);
  if (idx >= 0) return idx === 0 ? 0 : 1;
  let pos = -1;
  let first = -1;
  for (const ch of q) {
    pos = text.indexOf(ch, pos + 1);
    if (pos < 0) return null;
    if (first < 0) first = pos;
  }
  const span = pos - first + 1;
  return 2 + (span - q.length); // 间隔的字符越多越靠后
}

/**
 * 群管理搜索（模糊）：按群名或群号过滤。
 * - 忽略大小写、全半角、空格和括号等标点
 * - 字符按顺序出现即可，比如「高数班」能搜到「高数(2)班」
 * - 空格分开多个关键词，要求都能匹配（顺序不限）
 * - 结果按匹配程度排序，同样好的保持原顺序；关键词为空时原样返回
 */
export function filterGroups(groups: GroupDTO[], query: string): GroupDTO[] {
  const words = query
    .split(/\s+/)
    .map(normalize)
    .filter(Boolean);
  if (words.length === 0) return groups;

  const scored: { g: GroupDTO; score: number; i: number }[] = [];
  groups.forEach((g, i) => {
    const name = normalize(g.name);
    const id = normalize(g.group_id);
    let total = 0;
    for (const w of words) {
      const a = matchScore(name, w);
      const b = matchScore(id, w);
      if (a === null && b === null) return;
      total += Math.min(a ?? Infinity, b ?? Infinity);
    }
    scored.push({ g, score: total, i });
  });
  scored.sort((x, y) => x.score - y.score || x.i - y.i);
  return scored.map((x) => x.g);
}

/** 一键全开 / 全关：列表里状态和目标不一样、需要改的群 */
export function groupsToChange(groups: GroupDTO[], enabled: boolean): GroupDTO[] {
  return groups.filter((g) => g.enabled !== enabled);
}

/** 按每批 size 个并发执行，返回失败的数量（一个失败不影响其他） */
export async function runInBatches<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>): Promise<number> {
  let failed = 0;
  for (let i = 0; i < items.length; i += size) {
    const results = await Promise.allSettled(items.slice(i, i + size).map(fn));
    failed += results.filter((r) => r.status === 'rejected').length;
  }
  return failed;
}

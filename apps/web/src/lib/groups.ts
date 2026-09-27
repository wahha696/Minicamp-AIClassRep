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

/** 监听中的群排前面，同一类里保持原顺序（稳定排序） */
export function sortEnabledFirst(groups: GroupDTO[]): GroupDTO[] {
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => Number(b.g.enabled) - Number(a.g.enabled) || a.i - b.i)
    .map((x) => x.g);
}

/**
 * 按之前记下的群号顺序排列；order 里没有的群（后来新出现的）排在最后、保持原顺序。
 * 群管理页只在进页面时排一次序，之后拨开关、轮询都不挪位置，免得行在鼠标底下跳走。
 */
export function keepOrder(groups: GroupDTO[], order: string[]): GroupDTO[] {
  const pos = new Map(order.map((id, i) => [id, i]));
  return groups
    .map((g, i) => ({ g, i, p: pos.get(g.group_id) ?? order.length + i }))
    .sort((a, b) => a.p - b.p)
    .map((x) => x.g);
}

/** 一键全开 / 全关：列表里状态和目标不一样、需要改的群 */
export function groupsToChange(groups: GroupDTO[], enabled: boolean): GroupDTO[] {
  return groups.filter((g) => g.enabled !== enabled);
}

/** 要改的一个群开关 */
export interface GroupChange {
  group: GroupDTO;
  enabled: boolean;
}

/** 把「这些群要改成 enabled」变成改动列表 */
export function toChanges(groups: GroupDTO[], enabled: boolean): GroupChange[] {
  return groups.map((group) => ({ group, enabled }));
}

/** 撤销：把刚才的改动反过来 */
export function reverseChanges(changes: GroupChange[]): GroupChange[] {
  return changes.map((c) => ({ group: c.group, enabled: !c.enabled }));
}

/** 群管理预设：用户存下来的「只监听这几个群」 */
export interface GroupPreset {
  name: string;
  ids: string[]; // 监听中的群号
}

const PRESETS_KEY = 'classrep.groupPresets';

export function loadPresets(): GroupPreset[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (p): p is GroupPreset =>
        typeof p?.name === 'string' && Array.isArray(p?.ids) && p.ids.every((x: unknown) => typeof x === 'string'),
    );
  } catch {
    return [];
  }
}

export function savePresets(presets: GroupPreset[]): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch {
    // 存不了（隐私模式等）就算了，本次页面里仍然可用
  }
}

/** 当前监听中的群号（按列表顺序） */
export function enabledIds(groups: GroupDTO[]): string[] {
  return groups.filter((g) => g.enabled).map((g) => g.group_id);
}

/** 新增预设；同名的直接覆盖（位置不变） */
export function upsertPreset(presets: GroupPreset[], preset: GroupPreset): GroupPreset[] {
  const i = presets.findIndex((p) => p.name === preset.name);
  if (i < 0) return [...presets, preset];
  return presets.map((p, j) => (j === i ? preset : p));
}

/** 套用预设：预设里的群开启，其他群（包括存预设之后新出现的群）全部关闭；只返回需要改的 */
export function presetChanges(groups: GroupDTO[], preset: GroupPreset): GroupChange[] {
  const on = new Set(preset.ids);
  return groups
    .filter((g) => g.enabled !== on.has(g.group_id))
    .map((group) => ({ group, enabled: on.has(group.group_id) }));
}

/** 当前开关状态是否正好就是这个预设 */
export function matchesPreset(groups: GroupDTO[], preset: GroupPreset): boolean {
  return presetChanges(groups, preset).length === 0;
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

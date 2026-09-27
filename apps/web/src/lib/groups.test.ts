import { describe, expect, it, vi } from 'vitest';
import type { GroupDTO } from '../api/types';
import {
  enabledIds,
  filterGroups,
  groupsToChange,
  keepOrder,
  loadPresets,
  matchesPreset,
  presetChanges,
  reverseChanges,
  runInBatches,
  savePresets,
  sortEnabledFirst,
  toChanges,
  upsertPreset,
} from './groups';

const g = (group_id: string, name: string): GroupDTO => ({ group_id, name, enabled: true, message_count: 0, event_count: 0, course_name: null });
const list = [
  g('123456', '高数(2)班'),
  g('789012', 'Java 课程群'),
  g('demo-math', '线代答疑'),
  g('868497429', '计算机2510班班群'),
  g('836771057', '计算机2510班英语学习交流群'),
];
const names = (q: string) => filterGroups(list, q).map((x) => x.name);

describe('filterGroups', () => {
  it('关键词为空或只有空格时返回全部', () => {
    expect(filterGroups(list, '')).toEqual(list);
    expect(filterGroups(list, '   ')).toEqual(list);
  });

  it('按群名匹配，忽略大小写和首尾空格', () => {
    expect(names(' 高数 ')).toEqual(['高数(2)班']);
    expect(names('java')).toEqual(['Java 课程群']);
  });

  it('按群号匹配', () => {
    expect(filterGroups(list, '7890').map((x) => x.group_id)).toEqual(['789012']);
  });

  it('模糊：字符按顺序出现即可，忽略括号和空格', () => {
    expect(names('高数班')).toEqual(['高数(2)班']);
    expect(names('高数（2）')).toEqual(['高数(2)班']);
    expect(names('java课程')).toEqual(['Java 课程群']);
    expect(names('计2510英语')).toEqual(['计算机2510班英语学习交流群']);
  });

  it('全角字符也能搜', () => {
    expect(names('ＪＡＶＡ')).toEqual(['Java 课程群']);
  });

  it('空格分开多个关键词，顺序不限，都要匹配', () => {
    expect(names('英语 2510')).toEqual(['计算机2510班英语学习交流群']);
    expect(names('2510 数学')).toEqual([]);
  });

  it('越精确的越靠前', () => {
    expect(names('班群')).toEqual(['计算机2510班班群', '计算机2510班英语学习交流群']);
  });

  it('没有匹配时返回空数组', () => {
    expect(names('不存在')).toEqual([]);
  });
});

describe('一键全开 / 全关', () => {
  const mixed = [g('1', 'a'), { ...g('2', 'b'), enabled: false }, g('3', 'c')];

  it('只挑出需要改的群', () => {
    expect(groupsToChange(mixed, true).map((x) => x.group_id)).toEqual(['2']);
    expect(groupsToChange(mixed, false).map((x) => x.group_id)).toEqual(['1', '3']);
  });

  it('分批执行，统计失败数，失败不影响其他', async () => {
    const done: number[] = [];
    const failed = await runInBatches([1, 2, 3, 4, 5], 2, async (n) => {
      if (n === 3) throw new Error('x');
      done.push(n);
    });
    expect(failed).toBe(1);
    expect(done.sort()).toEqual([1, 2, 4, 5]);
  });

  it('撤销就是把改动反过来', () => {
    const changes = toChanges(mixed, false);
    expect(reverseChanges(changes).map((c) => c.enabled)).toEqual([true, true, true]);
  });
});

describe('群管理预设', () => {
  const groups = [g('1', 'a'), { ...g('2', 'b'), enabled: false }, g('3', 'c'), { ...g('4', 'd'), enabled: false }];

  it('记下当前监听中的群', () => {
    expect(enabledIds(groups)).toEqual(['1', '3']);
  });

  it('套用预设：预设里的开，其他的关，只返回需要改的', () => {
    const changes = presetChanges(groups, { name: '重要', ids: ['2', '3'] });
    expect(changes.map((c) => [c.group.group_id, c.enabled])).toEqual([
      ['1', false],
      ['2', true],
    ]);
  });

  it('预设里已经不存在的群直接忽略；存预设后新出现的群会被关掉', () => {
    const changes = presetChanges(groups, { name: '旧', ids: ['1', '3', 'gone'] });
    expect(changes).toEqual([]);
    const withNew = [...groups, g('5', 'new')];
    expect(presetChanges(withNew, { name: '旧', ids: ['1', '3'] }).map((c) => c.group.group_id)).toEqual(['5']);
  });

  it('判断当前是不是某个预设', () => {
    expect(matchesPreset(groups, { name: 'x', ids: ['3', '1'] })).toBe(true);
    expect(matchesPreset(groups, { name: 'y', ids: ['1'] })).toBe(false);
  });

  it('同名预设覆盖且位置不变，不同名追加', () => {
    const list = [
      { name: 'A', ids: ['1'] },
      { name: 'B', ids: ['2'] },
    ];
    expect(upsertPreset(list, { name: 'A', ids: ['3'] })).toEqual([
      { name: 'A', ids: ['3'] },
      { name: 'B', ids: ['2'] },
    ]);
    expect(upsertPreset(list, { name: 'C', ids: [] }).map((p) => p.name)).toEqual(['A', 'B', 'C']);
  });

  it('存到 localStorage 再读回来；坏数据读成空列表', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    try {
      expect(loadPresets()).toEqual([]);
      savePresets([{ name: '重要', ids: ['1', '3'] }]);
      expect(loadPresets()).toEqual([{ name: '重要', ids: ['1', '3'] }]);
      store.set('classrep.groupPresets', '{坏的');
      expect(loadPresets()).toEqual([]);
      store.set('classrep.groupPresets', JSON.stringify([{ name: 1 }, { name: 'ok', ids: ['9'] }]));
      expect(loadPresets()).toEqual([{ name: 'ok', ids: ['9'] }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('sortEnabledFirst / keepOrder', () => {
  const mk = (id: string, enabled: boolean): GroupDTO => ({ ...g(id, id), enabled });
  const ids = (xs: GroupDTO[]) => xs.map((x) => x.group_id);

  it('监听中的群排前面，同类保持原顺序', () => {
    const xs = [mk('a', false), mk('b', true), mk('c', false), mk('d', true)];
    expect(ids(sortEnabledFirst(xs))).toEqual(['b', 'd', 'a', 'c']);
  });

  it('按记下的顺序排，开关变了也不挪；新群排最后', () => {
    const order = ['b', 'd', 'a', 'c'];
    const xs = [mk('a', true), mk('b', false), mk('c', false), mk('d', true), mk('e', true)];
    expect(ids(keepOrder(xs, order))).toEqual(['b', 'd', 'a', 'c', 'e']);
  });
});

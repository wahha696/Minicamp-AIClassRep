import { describe, expect, it } from 'vitest';
import type { GroupDTO } from '../api/types';
import { filterGroups, groupsToChange, runInBatches } from './groups';

const g = (group_id: string, name: string): GroupDTO => ({ group_id, name, enabled: true, message_count: 0, event_count: 0 });
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
});

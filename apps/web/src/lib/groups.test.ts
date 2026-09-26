import { describe, expect, it } from 'vitest';
import type { GroupDTO } from '../api/types';
import { filterGroups } from './groups';

const g = (group_id: string, name: string): GroupDTO => ({ group_id, name, enabled: true, message_count: 0, event_count: 0 });
const list = [g('123456', '高数(2)班'), g('789012', 'Java 课程群'), g('demo-math', '线代答疑')];

describe('filterGroups', () => {
  it('关键词为空或只有空格时返回全部', () => {
    expect(filterGroups(list, '')).toEqual(list);
    expect(filterGroups(list, '   ')).toEqual(list);
  });

  it('按群名匹配，忽略大小写和首尾空格', () => {
    expect(filterGroups(list, ' 高数 ').map((x) => x.name)).toEqual(['高数(2)班']);
    expect(filterGroups(list, 'java').map((x) => x.name)).toEqual(['Java 课程群']);
  });

  it('按群号匹配', () => {
    expect(filterGroups(list, '7890').map((x) => x.group_id)).toEqual(['789012']);
  });

  it('没有匹配时返回空数组', () => {
    expect(filterGroups(list, '不存在')).toEqual([]);
  });
});

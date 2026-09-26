import type { GroupDTO } from '../api/types';

/** 群管理搜索：按群名或群号过滤，忽略大小写和首尾空格；关键词为空时原样返回 */
export function filterGroups(groups: GroupDTO[], query: string): GroupDTO[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups.filter((g) => g.name.toLowerCase().includes(q) || g.group_id.toLowerCase().includes(q));
}

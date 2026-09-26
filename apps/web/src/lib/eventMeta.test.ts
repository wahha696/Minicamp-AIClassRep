// levelStyle：6 种类型 × 4 档等级都有值（FR-12）；未知类型/越界等级兜底「其他·中」。
import { describe, expect, it } from 'vitest';
import { LEVEL_LABEL, levelStyle } from './eventMeta';

const TYPES = ['exam', 'assignment', 'meeting', 'activity', 'announcement', 'other'] as const;
const LEVELS = [1, 2, 3, 4] as const;

describe('levelStyle', () => {
  it('每种类型 × 每档等级都有 bg/bar/text', () => {
    for (const t of TYPES) {
      for (const lv of LEVELS) {
        const s = levelStyle(t, lv);
        expect(s.bg, `${t}/${lv}.bg`).toMatch(/^bg-\S+$/);
        expect(s.bar, `${t}/${lv}.bar`).toMatch(/^bg-\S+$/);
        expect(s.text, `${t}/${lv}.text`).toMatch(/^text-\S+$/);
      }
    }
  });

  it('等级越深、样式越深（同类型 4 级比 1 级深）', () => {
    for (const t of TYPES) {
      expect(levelStyle(t, 4).text).not.toBe(levelStyle(t, 1).text);
      expect(levelStyle(t, 4).bar).not.toBe(levelStyle(t, 1).bar);
    }
  });

  it('未知类型 / 越界等级 → 其他·中', () => {
    expect(levelStyle('alien', 3)).toEqual(levelStyle('other', 3));
    expect(levelStyle('exam', 0)).toEqual(levelStyle('exam', 2));
    expect(levelStyle('exam', 99)).toEqual(levelStyle('exam', 2));
  });
});

describe('LEVEL_LABEL', () => {
  it('1..4 都有中文名', () => {
    expect(LEVEL_LABEL).toEqual({ 1: '低', 2: '中', 3: '高', 4: '紧急' });
  });
});

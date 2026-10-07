// csujwc 纯函数部分的测试:登录置换算法 / 节次与周次解析 / kbtable 解析 / CourseDTO 转换。
import { describe, expect, it } from 'vitest';
import {
  encodeLogin,
  parseKbtable,
  parseSectionLabel,
  parseWeeksLine,
  sanitizeDiagnosticHtml,
  toCourseDTOs,
  type RawCourse,
} from './csujwc.js';

/** 教务登录页 submitForm1() 的等价移植(参照实现,防止移植时抄错一个字符) */
function referenceEncode(account: string, password: string, scode: string, sxh: string): string {
  const code = `${account}%%%${password}`;
  let encoded = '';
  let s = scode;
  for (let i = 0; i < code.length; i++) {
    if (i < 50) {
      const take = Number.parseInt(sxh.substring(i, i + 1), 10) || 0;
      encoded = encoded + code.substring(i, i + 1) + s.substring(0, take);
      s = s.substring(take, s.length);
    } else {
      encoded = encoded + code.substring(i, code.length);
      i = code.length; // 与原 JS 一致:跳出
    }
  }
  return encoded;
}

describe('encodeLogin(动态密钥置换)', () => {
  it('与登录页 JS 参照实现逐字符一致(30 组伪随机样例)', () => {
    let seed = 42;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const chars = 'abcdef0123456789';
    for (let round = 0; round < 30; round++) {
      const account = String(1000000000 + rand(900000000));
      const password = Array.from({ length: 6 }, () => chars[rand(chars.length)]).join('');
      const scode = Array.from({ length: 120 }, () => chars[rand(chars.length)]).join('');
      const sxh = Array.from({ length: 60 }, () => String(rand(8))).join('');
      expect(encodeLogin(account, password, scode, sxh)).toBe(
        referenceEncode(account, password, scode, sxh),
      );
    }
  });

  it('sxh 全 0 时不插入片段,encoded 就是「学号%%%密码」', () => {
    expect(encodeLogin('202301', 'pw', 'XYZ', '0000')).toBe('202301%%%pw');
  });
});

describe('parseSectionLabel', () => {
  it('识别两节区间与单节', () => {
    expect(parseSectionLabel('第1,2节')).toEqual([1, 2]);
    expect(parseSectionLabel('第3-4节')).toEqual([3, 4]);
    expect(parseSectionLabel('第5节')).toEqual([5, 5]);
    expect(parseSectionLabel('上午 第5,6节')).toEqual([5, 6]);
  });

  it('表头行/时段行返回 null', () => {
    expect(parseSectionLabel('节次/星期')).toBeNull();
    expect(parseSectionLabel('上午')).toBeNull();
    expect(parseSectionLabel('星期一')).toBeNull();
  });
});

describe('parseWeeksLine', () => {
  it('识别区间 / 枚举 / 单双周', () => {
    expect(parseWeeksLine('1-16周')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(parseWeeksLine('1-16周(单周)')).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
    expect(parseWeeksLine('2-10周(双)')).toEqual([2, 4, 6, 8, 10]);
    expect(parseWeeksLine('1,3,5-7周')).toEqual([1, 3, 5, 6, 7]);
  });

  it('非周次行返回 null(有数字但没有「周」也不行)', () => {
    expect(parseWeeksLine('高等数学')).toBeNull();
    expect(parseWeeksLine('新校区A-301')).toBeNull();
    expect(parseWeeksLine('张三')).toBeNull();
  });
});

const KB_HTML = `
<html><body><table id="kbtable">
  <tr><td>节次/星期</td><td>星期一</td><td>星期二</td><td>星期三</td></tr>
  <tr>
    <td rowspan="2">第1,2节</td>
    <td>高等数学<br>1-16周(单周)<br>张三<br>新校区A-301</td>
    <td></td>
    <td></td>
  </tr>
  <tr>
    <td></td>
    <td colspan="2">大学英语<br>2-16周(双)<br>李四<br>外语楼302</td>
  </tr>
</table></body></html>`;

describe('parseKbtable', () => {
  it('解析课程格:名称/周次/教师/地点/星期/节次,并处理 rowspan 与 colspan', () => {
    const { raw, warnings } = parseKbtable(KB_HTML);
    expect(warnings.some(w=>w.includes('跨多个星期'))).toBe(true);
    expect(raw).toHaveLength(1); // 跨周二、周三的合并格不能猜成只有周二

    expect(raw[0]).toMatchObject({
      name: '高等数学',
      teacher: '张三',
      location: '新校区A-301',
      dayOfWeek: 1,
      startSection: 1,
      endSection: 2,
      weeks: [1, 3, 5, 7, 9, 11, 13, 15],
    });
  });

  it('登录页直接报错提示重新导入', () => {
    expect(() => parseKbtable('<input id="userAccount" />')).toThrow(/重新导入/);
  });
});

describe('sanitizeDiagnosticHtml', () => {
  it('仅保留表格结构，不落盘姓名、学号、ticket、脚本或非结构属性', () => {
    const safe = sanitizeDiagnosticHtml(`
      <html><head><title>张三的课表</title><script>token=secret-ticket</script></head>
      <body data-user="2023123456"><table class="student"><tr><td rowspan="2" title="秘密">高等数学 张三 2023123456</td></tr></table></body></html>
    `);
    expect(safe).toContain('rowspan="2"');
    expect(safe).toContain('[TEXT length=');
    expect(safe).not.toMatch(/张三|高等数学|2023123456|secret-ticket|data-user|class="student"|title="秘密"/);
  });
});

describe('toCourseDTOs(节次对齐 5 块 + 合并)', () => {
  it('1-2 节→块1,5-6 节→块3;周次收敛到 1~30', () => {
    const raw: RawCourse[] = [
      { name: '高等数学', teacher: '张三', location: 'A-301', dayOfWeek: 1, startSection: 1, endSection: 2, weeks: [1, 2, 3] },
      { name: '大学物理', teacher: '王五', location: 'B-102', dayOfWeek: 2, startSection: 5, endSection: 6, weeks: [1, 2] },
    ];
    const dtos = toCourseDTOs(raw);
    expect(dtos).toHaveLength(2);
    expect(dtos[0]).toMatchObject({ weekday: 1, block: 1, weeks: [1, 2, 3] });
    expect(dtos[1]).toMatchObject({ weekday: 2, block: 3 });
  });

  it('跨块不压缩，11 节保留；无效周次整条待确认而不是静默截断', () => {
    const raw: RawCourse[] = [
      { name: '体育', teacher: '李四', location: '体育馆', dayOfWeek: 5, startSection: 2, endSection: 3, weeks: [1, 2] },
      { name: '选修', teacher: '', location: '', dayOfWeek: 3, startSection: 1, endSection: 11, weeks: [1] },
      { name: '高等数学', teacher: '张三', location: 'A-301', dayOfWeek: 1, startSection: 1, endSection: 2, weeks: [1, 3, 5] },
      { name: '高等数学', teacher: '张三', location: 'A-301', dayOfWeek: 1, startSection: 1, endSection: 2, weeks: [7, 99] },
    ];
    const warnings: string[] = [];
    const dtos = toCourseDTOs(raw, warnings);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('99');
    expect(dtos).toHaveLength(3);
    expect(dtos[0]).toMatchObject({start_period:2,end_period:3});
    expect(dtos[1]).toMatchObject({start_period:1,end_period:11});
    const math = dtos.find((d) => d.name === '高等数学')!;
    expect(math.weeks).toEqual([1, 3, 5]);
    expect(dtos.find((d) => d.name === '高等数学')!.block).toBe(1);
  });
});

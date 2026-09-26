// 业务路由：事件 / 今日 / 导出 / 群 / 演示。主人是 B。
// B0 只注册一个能编译、能返回的空壳；真实实现在 B3~B6。
import type { Hono } from 'hono';
import type { TodayDTO } from '../types.js';

/** 今天（Asia/Shanghai）的 'YYYY-MM-DD' */
function shanghaiDate(now: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now));
}

export function registerBusinessRoutes(app: Hono): void {
  // B3 会补上 /api/events、/api/events/:id、PATCH、/api/export.ics
  app.get('/api/today', (c) => {
    const body: TodayDTO = {
      date: shanghaiDate(),
      summary: '今天没有待办，轻松一天',
      events: [],
    };
    return c.json(body);
  });
}

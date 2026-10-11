import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildCalendarProbe, createPushplusTestQr, queryPushplusTest, sendPushplusTest } from './lib/reminder-feasibility.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'calendar' && args.length === 1) {
    const destination = resolve(args[0]);
    writeFileSync(destination, buildCalendarProbe(), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ state: 'calendar_created', path: destination, phone_verified: false }));
  } else if (command === 'pushplus-send' && args.length === 1 && args[0] === '--approve-test-send') {
    console.log(JSON.stringify(await sendPushplusTest({ approve: true, token: process.env.CLASSREP_PROBE_PUSHPLUS_TOKEN, recipient: process.env.CLASSREP_PROBE_PUSHPLUS_RECIPIENT })));
  } else if (command === 'pushplus-qr' && args.length === 1 && args[0] === '--approve-test-qr') {
    console.log(JSON.stringify(await createPushplusTestQr({ approve: true, accessKey: process.env.CLASSREP_PROBE_PUSHPLUS_ACCESS_KEY })));
  } else if (command === 'pushplus-query' && args.length === 1) {
    console.log(JSON.stringify(await queryPushplusTest({ accessKey: process.env.CLASSREP_PROBE_PUSHPLUS_ACCESS_KEY, receipt: args[0] })));
  } else {
    console.log('仅准备人工测试，不读取课代表或微信数据。\ncalendar <新文件.ics>\npushplus-qr --approve-test-qr\npushplus-send --approve-test-send\npushplus-query <本次流水号>\n凭据仅从 CLASSREP_PROBE_PUSHPLUS_* 环境变量读取，不要放到命令参数或聊天中。');
    if (command && command !== '--help') process.exitCode = 1;
  }
} catch {
  console.error('测试准备失败：检查参数、凭据或目标文件是否已存在。没有自动重发；不要公开凭据。');
  process.exitCode = 1;
}

// 写 NapCat 配置（架构.md §3 第 2 步、§4.1；NapCat接口规格.md §2/§3）。主人是 A（分工 A2）。
// napcat/ 归 ClassRep 独占，每次启动都整份覆盖写，不做合并。
//   1. config/onebot11.json + 已存在的每个 config/onebot11_*.json ← §4.1 固定内容。
//      账号首次登录且没有 onebot11_<uin>.json 时，NapCat 会以 onebot11.json 为模板生成它，
//      所以不需要事先知道 QQ 号（接口规格 §3）。
//   2. config/webui.json ← 读出已有内容（没有/非法就用 {}），只把 disableWebUI 改为 true 后写回，
//      不动其他字段——字段类型写错会导致整份配置读取失败退回默认值（接口规格 §2）。
//   3. loadNapCat.js ← 用 pathToFileURL 生成动态 import，中文/空格路径安全（接口规格 §1）。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NAPCAT_DIR } from './paths.js';

/** 架构.md §4.1 的 OneBot 配置，唯一一份（合法 JSON，不带注释） */
export function onebot11Config(): Record<string, unknown> {
  return {
    network: {
      httpServers: [], httpSseServers: [], httpClients: [], websocketClients: [], plugins: [],
      websocketServers: [{
        name: 'classrep', enable: true, host: '127.0.0.1', port: 3001,
        messagePostFormat: 'array', reportSelfMessage: true, token: '',
        enableForcePushEvent: true, debug: false, heartInterval: 30000,
      }],
    },
    musicSignUrl: '', enableLocalFile2Url: false, parseMultMsg: false,
  };
}

/**
 * 写三类配置文件。napcatDir 参数供测试注入临时目录；生产调用不传参（= NAPCAT_DIR）。
 * 配置目录不存在会自动创建。
 */
export function writeNapcatConfig(napcatDir: string = NAPCAT_DIR): void {
  const cfgDir = join(napcatDir, 'config');
  mkdirSync(cfgDir, { recursive: true });

  // 1) onebot11.json + 所有已存在的 onebot11_*.json ← 同一份固定内容
  const onebotJson = JSON.stringify(onebot11Config(), null, 2);
  const files = ['onebot11.json', ...readdirSync(cfgDir).filter((f) => /^onebot11_.+\.json$/.test(f))];
  for (const f of files) {
    writeFileSync(join(cfgDir, f), onebotJson, 'utf8');
  }

  // 2) webui.json：读已有（没有/非法 → {}），只改 disableWebUI 后写回
  let webui: Record<string, unknown> = {};
  try {
    webui = JSON.parse(readFileSync(join(cfgDir, 'webui.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    // 没有或内容非法 → 用 {}；WebUI 字段类型写错会让整份配置退回默认值（接口规格 §2）
  }
  webui.disableWebUI = true;
  writeFileSync(join(cfgDir, 'webui.json'), JSON.stringify(webui, null, 2), 'utf8');

  // 3) loadNapCat.js：pathToFileURL，中文/空格路径安全（bat 版的字符串拼 file:/// 不可靠）
  const entry = pathToFileURL(join(napcatDir, 'napcat.mjs')).href;
  writeFileSync(join(napcatDir, 'loadNapCat.js'), `(async () => {await import("${entry}")})()`, 'utf8');
}

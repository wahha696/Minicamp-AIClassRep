// NapCat 相关路径与 QQ.exe 定位。主人是 A。
import { join } from 'node:path';
import { NAPCAT_DIR, ROOT } from '../paths.js';

export { NAPCAT_DIR, ROOT };

/** NapCat 的 OneBot 配置目录 */
export const NAPCAT_CONFIG_DIR: string = join(NAPCAT_DIR, 'config');

/** 二维码落在这里，前端经 GET /api/connect/qrcode 取 */
export const QRCODE_PATH: string = join(NAPCAT_DIR, 'cache', 'qrcode.png');

/** QQ.exe 定位：注册表 → 默认路径（实现见 A） */
export function findQQPath(): string | null {
  return null;
}

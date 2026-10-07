// 让后端也信任 Windows 系统证书库里的根证书。
// 卡巴斯基等杀毒软件会「检查加密连接」：用自己的根证书重新签发网站证书。Windows 信任它，
// Node 默认只认自带的证书列表，于是调 DeepSeek 报 SELF_SIGNED_CERT_IN_CHAIN（AI 灯显示「最近一次调用失败」）。
// 这里把系统证书并进默认列表（Node ≥ 22.15 / 23.8 才有这两个 API，老版本什么都不做）。
import tls from 'node:tls';
import { redactSensitive } from './redact.js';

export function trustSystemCertificates(): void {
  const t = tls as typeof tls & {
    getCACertificates?: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[];
    setDefaultCACertificates?: (certs: string[]) => void;
  };
  if (typeof t.getCACertificates !== 'function' || typeof t.setDefaultCACertificates !== 'function') return;
  try {
    const merged = new Set([...t.getCACertificates('default'), ...t.getCACertificates('system')]);
    t.setDefaultCACertificates([...merged]);
  } catch (e) {
    console.warn(`[tls] 读取系统证书失败，继续使用默认证书：${redactSensitive(e)}`);
  }
}

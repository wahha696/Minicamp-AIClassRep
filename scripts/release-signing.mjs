import { createPublicKey, verify } from 'node:crypto';

// 私钥只存在 GitHub Actions secret CLASSREP_RELEASE_SIGNING_KEY 中。
// 这个公钥被编译进客户端，更换时需先发布支持新钥的过渡版。
export const RELEASE_MANIFEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgRniB9HEdg72qAvO0dxBy2rHQ58ZnYVSTXN6xpbZ1/o=
-----END PUBLIC KEY-----`;

/** Ed25519 签名覆盖发布清单的原始字节，不先解析/重序列化 JSON。 */
export function verifyReleaseManifestSignature(manifest, signatureText, publicKey = RELEASE_MANIFEST_PUBLIC_KEY) {
  try {
    const signature = Buffer.from(String(signatureText).trim(), 'base64');
    if (signature.length !== 64) return false;
    return verify(null, Buffer.from(manifest), createPublicKey(publicKey), signature);
  } catch {
    return false;
  }
}

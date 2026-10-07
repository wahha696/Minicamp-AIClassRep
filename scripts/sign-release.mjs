import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RELEASE_MANIFEST_PUBLIC_KEY,
  verifyReleaseManifestSignature,
} from './release-signing.mjs';

const manifestPath = resolve(process.argv[2] ?? 'release/ClassRep.manifest.json');
const signaturePath = resolve(process.argv[3] ?? 'release/ClassRep.manifest.sig');
const privatePem = process.env.CLASSREP_RELEASE_SIGNING_KEY?.trim();
if (!privatePem) throw new Error('Missing GitHub secret CLASSREP_RELEASE_SIGNING_KEY');

const privateKey = createPrivateKey(privatePem);
const derivedPublic = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString().trim();
assert.equal(derivedPublic, RELEASE_MANIFEST_PUBLIC_KEY.trim(), '签名私钥与客户端内置公钥不匹配');
const manifest = readFileSync(manifestPath);
const signature = sign(null, manifest, privateKey).toString('base64');
assert.equal(verifyReleaseManifestSignature(manifest, signature), true, '签名回读校验失败');
writeFileSync(signaturePath, `${signature}\n`, { encoding: 'utf8', mode: 0o644 });
console.log(`Signed ${manifestPath} -> ${signaturePath}`);

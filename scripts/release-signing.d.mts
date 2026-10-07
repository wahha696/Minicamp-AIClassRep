export const RELEASE_MANIFEST_PUBLIC_KEY: string;
export function verifyReleaseManifestSignature(
  manifest: Uint8Array,
  signatureText: string,
  publicKey?: string,
): boolean;

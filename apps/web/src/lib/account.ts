// ConnectStatusProvider 同步当前空间和 QQ 身份。群预设等业务偏好按空间隔离，
// 微信单独使用也不会落入其他空间；旧服务无 workspace 字段时保持原 QQ 键。
let uin: string | null = null;
let space: string | null | undefined;

export function setCurrentSpace(value: string | null | undefined): void { space = value; }

export function setCurrentUin(u: string | undefined | null): void {
  uin = u ?? null;
  space = undefined;
}

export function currentUin(): string | null {
  return uin;
}

/** 账号限定的 localStorage 键：登录后变成 `base@<uin>`；没登录就是 base */
export function accountKey(base: string): string {
  if (space !== undefined) return space === null ? `${base}@space:none` : `${base}@space:${space}`;
  return uin === null ? base : `${base}@${uin}`;
}

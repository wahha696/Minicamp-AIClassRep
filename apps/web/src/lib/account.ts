// 当前登录的 QQ 号（修复计划第一节 §4）：ConnectStatusProvider 每次拿到 status 后写进来。
// 依赖账号的 localStorage 键（群预设、skipConnect、接管提示）都以它为后缀——
// 换号后读写的是另一套键，新号不会继承旧号的「跳过引导 / 已提示 / 群预设」。
// 未登录（uin 为空）时键保持原样，兼容升级前已经写过的全局键。
let uin: string | null = null;

export function setCurrentUin(u: string | undefined | null): void {
  uin = u ?? null;
}

export function currentUin(): string | null {
  return uin;
}

/** 账号限定的 localStorage 键：登录后变成 `base@<uin>`；没登录就是 base */
export function accountKey(base: string): string {
  return uin === null ? base : `${base}@${uin}`;
}

/** Fixed browser settings only. Call exclusively after an explicit plan confirmation. */
export function applyPetAssistantSettings(input: unknown): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('桌宠设置格式无效');
  const patch = input as Record<string, unknown>;
  const keys = Object.keys(patch);
  if (!keys.length || keys.some(key => !['visible', 'style', 'reset_image', 'reset_position'].includes(key))) throw new Error('包含不允许的桌宠设置');
  for (const key of ['visible', 'reset_image', 'reset_position']) if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw new Error('桌宠开关格式无效');
  if (patch.style !== undefined && (typeof patch.style !== 'string' || patch.style.length > 120)) throw new Error('说话风格最多 120 字');
  const changes: [string, string | null][] = [];
  if (typeof patch.visible === 'boolean') changes.push(['classrep.pet.hidden', patch.visible ? '0' : '1']);
  if (typeof patch.style === 'string') changes.push(['classrep.pet.style', patch.style.trim()]);
  if (patch.reset_image === true) changes.push(['classrep.pet.img', null]);
  if (patch.reset_position === true) changes.push(['classrep.pet.x', '0'], ['classrep.pet.y', '0']);
  const old = changes.map(([key]) => [key, localStorage.getItem(key)] as const);
  try { for (const [key, value] of changes) value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); }
  catch { for (const [key, value] of old) { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* Preserve original failure. */ } } throw new Error('浏览器不允许保存桌宠设置，请检查本地存储权限'); }
  window.dispatchEvent(new Event('classrep:pet-settings'));
}

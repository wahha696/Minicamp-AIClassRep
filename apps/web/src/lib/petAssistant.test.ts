// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { applyPetAssistantSettings } from './petAssistant';
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
it('固定桌宠字段保存并通知UI，不修改其他localStorage', () => {
  localStorage.setItem('unrelated', 'keep'); localStorage.setItem('classrep.pet.img', 'synthetic-image');
  const changed = vi.fn(); window.addEventListener('classrep:pet-settings', changed);
  applyPetAssistantSettings({ visible: true, style: ' 合成风格 ', reset_image: true, reset_position: true });
  expect(localStorage.getItem('classrep.pet.hidden')).toBe('0'); expect(localStorage.getItem('classrep.pet.style')).toBe('合成风格');
  expect(localStorage.getItem('classrep.pet.img')).toBeNull(); expect(localStorage.getItem('unrelated')).toBe('keep'); expect(changed).toHaveBeenCalledOnce();
  window.removeEventListener('classrep:pet-settings', changed);
});
it('任意storage键、URL、错误类型和过长style均拒绝', () => {
  for (const value of [{ api_key: 'bad' }, { image: 'https://untrusted.example/' }, { visible: 'false' }, { style: 'x'.repeat(121) }]) expect(() => applyPetAssistantSettings(value)).toThrow();
  expect(localStorage.length).toBe(0);
});
it('浏览器拒绝存储时回滚且不发成功事件', () => {
  localStorage.setItem('classrep.pet.style', '旧风格'); const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) { if (key === 'classrep.pet.style' && value === '新风格') throw new Error('denied'); original.call(this, key, value); });
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  expect(() => applyPetAssistantSettings({ visible: false, style: '新风格' })).toThrow('浏览器不允许保存');
  expect(localStorage.getItem('classrep.pet.hidden')).toBeNull(); expect(localStorage.getItem('classrep.pet.style')).toBe('旧风格'); expect(dispatch).not.toHaveBeenCalled();
});

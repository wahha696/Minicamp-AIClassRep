// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), test: vi.fn() }));
vi.mock('../api/client', () => ({ getAiSettings: api.get, saveAiSettings: api.save, testAiSettings: api.test }));
import AiSettingsCard from './AiSettingsCard';
const settings = { deepseek: { configured: true, key_hint: 'sk-old...old', source: 'local', protection: 'dpapi' } };
beforeEach(() => {
  Object.values(api).forEach(fn => fn.mockReset());
  api.get.mockResolvedValue(settings); api.save.mockResolvedValue(settings);
});
afterEach(cleanup);
async function edit() {
  render(<AiSettingsCard />); fireEvent.click(await screen.findByRole('button', { name: '更换' }));
  fireEvent.change(screen.getByLabelText('DeepSeek（必填）'), { target: { value: 'sk-synthetic-candidate' } });
  fireEvent.click(screen.getByRole('button', { name: '测试并保存' }));
}
it('候选鉴权失败不覆盖旧配置，也不保存候选', async () => {
  api.test.mockResolvedValue({ deepseek: { ok: false, error: '人工鉴权失败' } });
  await edit(); await screen.findByText('人工鉴权失败');
  expect(api.test).toHaveBeenCalledWith('deepseek', 'sk-synthetic-candidate');
  expect(api.save).not.toHaveBeenCalled();
});
it('验证未返回时不能取消或改输入，成功之后才保存该候选', async () => {
  let finish!: (value: unknown) => void;
  api.test.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await edit();
  expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('DeepSeek（必填）') as HTMLInputElement).disabled).toBe(true);
  expect(api.save).not.toHaveBeenCalled(); finish({ deepseek: { ok: true } });
  await waitFor(() => expect(api.save).toHaveBeenCalledWith({ deepseek_key: 'sk-synthetic-candidate' }));
});
it('自定义 OpenAI 兼容服务：只填 base_url 和 key，检查后用自动选中的模型保存', async () => {
  api.test.mockResolvedValue({ deepseek: { ok: true, model: 'auto-model' } });
  render(<AiSettingsCard />); fireEvent.click(await screen.findByRole('button', { name: '更换' }));
  fireEvent.change(screen.getByLabelText('服务商'), { target: { value: 'custom' } });
  fireEvent.change(screen.getByLabelText('接口地址（base_url）'), { target: { value: 'https://llm.example.test/v1' } });
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'custom-key' } });
  fireEvent.click(screen.getByRole('button', { name: '测试并保存' }));
  const candidate = { provider: 'custom', base_url: 'https://llm.example.test/v1', model: undefined, api_key: 'custom-key' };
  await waitFor(() => expect(api.save).toHaveBeenCalledWith({ llm: { ...candidate, model: 'auto-model' } }));
  expect(api.test).toHaveBeenCalledWith('deepseek', undefined, candidate);
});

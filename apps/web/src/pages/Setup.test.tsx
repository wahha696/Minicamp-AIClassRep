// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), test: vi.fn() }));
vi.mock('../api/client', () => ({ getAiSettings: api.get, saveAiSettings: api.save, testAiSettings: api.test }));
import Setup from './Setup';

const empty = { deepseek: { configured: false, provider: 'deepseek', source: 'none', key_hint: '', protection: 'none' } };
beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.get.mockResolvedValue(empty);
  api.save.mockResolvedValue({ deepseek: { ...empty.deepseek, configured: true, provider: 'custom' } });
});
afterEach(cleanup);

async function custom(model = 'synthetic-model') {
  render(<MemoryRouter><Setup /></MemoryRouter>);
  fireEvent.change(await screen.findByLabelText('服务商'), { target: { value: 'custom' } });
  fireEvent.change(screen.getByLabelText('接口地址（base_url）'), { target: { value: 'https://llm.example.test/v1' } });
  fireEvent.change(screen.getByLabelText('模型名'), { target: { value: model } });
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-key' } });
  fireEvent.click(screen.getByRole('button', { name: '测试并继续' }));
}

it('首次使用可填写自定义 endpoint、模型和密钥，检查与保存全部完成后才进入连接步骤', async () => {
  let finishSave!: (value: unknown) => void;
  api.test.mockResolvedValue({ deepseek: { ok: true } });
  api.save.mockReturnValue(new Promise((resolve) => { finishSave = resolve; }));
  await custom();
  const candidate = { provider: 'custom', base_url: 'https://llm.example.test/v1', model: 'synthetic-model', api_key: 'synthetic-key' };
  await waitFor(() => expect(api.save).toHaveBeenCalledWith({ llm: candidate }));
  expect(api.test).toHaveBeenCalledWith('deepseek', undefined, candidate);
  expect(screen.queryByRole('button', { name: '去连接账号 →' })).toBeNull();
  finishSave({ deepseek: { ...empty.deepseek, configured: true, provider: 'custom' } });
  expect(await screen.findByRole('button', { name: '去连接账号 →' })).toBeTruthy();
});

it('首次自定义服务省略模型时保存鉴权检查返回的模型', async () => {
  api.test.mockResolvedValue({ deepseek: { ok: true, model: 'discovered-model' } });
  await custom('');
  await screen.findByRole('button', { name: '去连接账号 →' });
  expect(api.save).toHaveBeenCalledWith({ llm: { provider: 'custom', base_url: 'https://llm.example.test/v1', model: 'discovered-model', api_key: 'synthetic-key' } });
});

it('自定义鉴权失败保留输入，不保存也不进入下一步', async () => {
  api.test.mockResolvedValue({ deepseek: { ok: false, error: '模拟鉴权失败' } });
  await custom();
  await screen.findByText('模拟鉴权失败');
  expect(api.save).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '去连接账号 →' })).toBeNull();
  expect((screen.getByLabelText('模型名') as HTMLInputElement).value).toBe('synthetic-model');
});

it('已有自定义服务配置无需重新填 DeepSeek 密钥', async () => {
  api.get.mockResolvedValue({ deepseek: { ...empty.deepseek, configured: true, provider: 'custom' } });
  render(<MemoryRouter><Setup /></MemoryRouter>);
  await screen.findByText('已有 AI 配置，接下来连接账号');
  expect(screen.queryByLabelText('DeepSeek（必填）')).toBeNull();
  expect(api.test).not.toHaveBeenCalled();
});

it('默认 DeepSeek 路径仍通过检查再保存', async () => {
  api.test.mockResolvedValue({ deepseek: { ok: true } });
  render(<MemoryRouter><Setup /></MemoryRouter>);
  fireEvent.change(await screen.findByLabelText('DeepSeek（必填）'), { target: { value: 'synthetic-deepseek-key' } });
  fireEvent.click(screen.getByRole('button', { name: '测试并继续' }));
  await screen.findByRole('button', { name: '去连接账号 →' });
  expect(api.test).toHaveBeenCalledWith('deepseek', 'synthetic-deepseek-key');
  expect(api.save).toHaveBeenCalledWith({ deepseek_key: 'synthetic-deepseek-key' });
});

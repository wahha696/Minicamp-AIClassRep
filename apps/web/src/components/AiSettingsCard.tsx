// 「AI 接入」卡片（修复计划 3.2）：大模型必填，默认 DeepSeek，也可接入任意 OpenAI 兼容服务
// （填 base_url + api_key，模型可留空自动选）。连接页、设置页共用。候选配置先检查鉴权，通过后才替换已保存配置。
import { useEffect, useState, type FormEvent } from 'react';
import { getAiSettings, saveAiSettings, testAiSettings } from '../api/client';
import type { AiSettingsDTO, LlmProvider } from '../api/types';
import { useToast } from './Toast';
import { toastError } from '../lib/errors';

type TestResult = { ok: boolean; error?: string; model?: string };
type LlmStatus = AiSettingsDTO['deepseek'];

const input = 'w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm outline-none focus:border-slate-500';

export default function AiSettingsCard() {
  const toast = useToast();
  const [info, setInfo] = useState<AiSettingsDTO | null>(null);

  useEffect(() => {
    getAiSettings()
      .then(setInfo)
      .catch((e) => toastError(toast, e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-6 py-6 text-left shadow-sm">
      <LlmRow status={info?.deepseek} onSaved={setInfo} />
      <p className="mt-4 text-xs text-slate-400">群消息经本地快判模型过滤后再交 AI 整理，无需配置。</p>
      {info?.deepseek.protection === 'plain' && (
        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          当前系统加密（DPAPI）不可用，密钥正以明文保存在这台电脑的 data 目录下。请勿把 data 目录拷给他人；
          更换 Windows 用户或重装系统后需要重新填写。
        </p>
      )}
    </div>
  );
}

function LlmRow({ status, onSaved }: { status?: LlmStatus; onSaved: (next: AiSettingsDTO) => void }) {
  const toast = useToast();
  const savedProvider: LlmProvider = status?.provider ?? 'deepseek';
  const [provider, setProvider] = useState<LlmProvider>(savedProvider);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const configured = status?.configured === true;
  const custom = provider === 'custom';
  // 同一服务商下改地址/模型可以不重填 key（后端沿用已保存的）
  const keyOptional = configured && status?.source === 'web' && provider === savedProvider;

  useEffect(() => {
    if (status !== undefined && !status.configured) setEditing(true);
  }, [status]);

  function startEdit() {
    setResult(null);
    setProvider(savedProvider);
    setBaseUrl(savedProvider === 'custom' ? status?.base_url ?? '' : '');
    setModel(savedProvider === 'custom' ? status?.model ?? '' : '');
    setEditing(true);
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (busy) return;
    const k = key.trim();
    if (!k && !(custom && keyOptional)) {
      toast('请先填写 API Key', 'error');
      return;
    }
    if (custom && !baseUrl.trim()) {
      toast('请填写接口地址（base_url）', 'error');
      return;
    }
    setBusy(true);
    setResult(null);
    let picked: string | undefined;
    try {
      if (!custom) {
        const r = (await testAiSettings('deepseek', k)).deepseek ?? { ok: false, error: '没有返回结果' };
        setResult(r);
        if (!r.ok) return void toast('检查未通过，未替换已保存配置', 'error');
        onSaved(await saveAiSettings({ deepseek_key: k }));
      } else {
        const candidate = { provider, base_url: baseUrl.trim(), model: model.trim() || undefined, ...(k ? { api_key: k } : {}) };
        const r = (await testAiSettings('deepseek', undefined, candidate)).deepseek ?? { ok: false, error: '没有返回结果' };
        setResult(r);
        if (!r.ok) return void toast('检查未通过，未替换已保存配置', 'error');
        picked = candidate.model ? undefined : r.model;
        onSaved(await saveAiSettings({ llm: { ...candidate, model: candidate.model ?? r.model } }));
      }
      setKey('');
      setEditing(false);
      toast(picked ? `鉴权检查通过，已保存（模型：${picked}）` : '鉴权检查通过，已保存');
    } catch (e) {
      toastError(toast, e);
    } finally {
      setBusy(false);
    }
  }

  const resultText = result && (
    <span className={`text-xs ${result.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
      {result.ok ? '鉴权检查通过（不代表消息整理成功）' : (result.error ?? '连接失败')}
    </span>
  );

  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-800">大模型（必填）</h3>

      {configured && !editing ? (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-3 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm">
            <span className="min-w-0 text-emerald-700">
              已保存 · {savedProvider === 'custom' ? '自定义' : 'DeepSeek'} · <span className="font-mono">{status!.key_hint}</span>
              {status!.source === 'env' && <span className="ml-1 text-emerald-600/70">（来自 .env）</span>}
              {savedProvider === 'custom' && (
                <span className="block truncate text-xs text-emerald-600/80" title={status!.base_url}>
                  {status!.model} @ {status!.base_url}
                </span>
              )}
            </span>
            <button type="button" disabled={busy} onClick={startEdit} className="shrink-0 font-medium text-slate-600 hover:underline disabled:opacity-50">
              更换
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <button type="button" disabled={busy} className="text-xs text-sky-700 underline disabled:opacity-60" onClick={() => {
              setBusy(true);
              void testAiSettings('deepseek').then((r) => setResult(r.deepseek ?? { ok: false, error: '没有返回结果' }), (e) => toastError(toast, e))
                .finally(() => setBusy(false));
            }}>检查已保存的配置</button>
            {resultText}
          </div>
        </div>
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} className="mt-3 space-y-2">
          <select aria-label="服务商" value={provider} disabled={busy}
            onChange={(e) => { setResult(null); setProvider(e.target.value as LlmProvider); }}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="deepseek">DeepSeek（默认）</option>
            <option value="custom">自定义（OpenAI 兼容接口）</option>
          </select>
          {custom && (
            <>
              <input disabled={busy} autoComplete="off" value={baseUrl} aria-label="接口地址（base_url）"
                onChange={(e) => { setResult(null); setBaseUrl(e.target.value); }}
                placeholder="接口地址，如 https://api.example.com/v1" className={input} />
              <input disabled={busy} autoComplete="off" value={model} aria-label="模型名"
                onChange={(e) => { setResult(null); setModel(e.target.value); }}
                placeholder="模型名（可留空，自动选用服务返回的第一个）" className={input} />
            </>
          )}
          <input
            type="password"
            disabled={busy}
            autoComplete="off"
            value={key}
            onChange={(e) => { setResult(null); setKey(e.target.value); }}
            placeholder={custom ? (keyOptional ? 'API Key（留空沿用已保存的）' : 'API Key') : 'sk-...'}
            aria-label={custom ? 'API Key' : 'DeepSeek（必填）'}
            className={input}
          />
          <p className="text-xs text-slate-400">
            {custom ? (
              '需兼容 OpenAI 的 /chat/completions 接口，地址一般以 /v1 结尾'
            ) : (
              <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer" className="underline">
                在 DeepSeek 开放平台创建
              </a>
            )}
            。只保存在这台电脑上。
          </p>
          <div className="flex items-center justify-end gap-2 pt-1">
            {configured && (
              <button
                type="button"
                disabled={busy}
                onClick={() => { setEditing(false); setKey(''); setResult(null); }}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                取消
              </button>
            )}
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
            >
              {busy ? '校验中…' : '测试并保存'}
            </button>
          </div>
          {result && <p>{resultText}</p>}
        </form>
      )}
    </div>
  );
}

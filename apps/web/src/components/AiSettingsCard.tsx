// 「AI 接入」卡片（修复计划 3.2）：DeepSeek（必填）+ Jev/TypeSafe（可选）。
// 连接页、设置页、/setup 向导共用。key 只显示打码提示；「测试并保存」先保存再做真实连通性校验。
import { useEffect, useState, type FormEvent } from 'react';
import { getAiSettings, saveAiSettings, testAiSettings } from '../api/client';
import type { AiKeyStatusDTO, AiSettingsDTO } from '../api/types';
import { useToast } from './Toast';
import { toastError } from '../lib/errors';

const mask = (s: AiKeyStatusDTO) => (s.configured ? s.key_hint : '');

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
      <KeyRow
        title="DeepSeek（必填）"
        canClear={false}
        hintText="在 DeepSeek 开放平台创建"
        hintUrl="https://platform.deepseek.com/api_keys"
        placeholder="sk-..."
        status={info?.deepseek}
        sourceNote={info?.deepseek.source === 'env'}
        onSave={async (key) => {
          const next = await saveAiSettings({ deepseek_key: key });
          setInfo(next);
        }}
        onTest={async () => (await testAiSettings('deepseek')).deepseek ?? { ok: false, error: '没有返回结果' }}
      />
      <div className="my-5 border-t border-slate-100" />
      <KeyRow
        title="Jev / TypeSafe（可选）"
        canClear
        hintText="填了先用快判过滤群消息，省 AI 调用、更快"
        hintUrl="https://typesafe.ai"
        placeholder="jev key..."
        status={info?.jev}
        sourceNote={info?.jev.source === 'env'}
        disabledNote={!info ? undefined : !info.jev.enabled
          ? '已被 ENABLE_JEV 关闭（.env）'
          : info.jev.mode === 'local'
            ? `FASTJUDGE_MODE=local：路由走本地模型${info.jev.local_configured ? '' : '（未配置，会回退直连 AI）'}，此 key 不参与`
            : info.jev.mode === 'dual'
              ? 'FASTJUDGE_MODE=dual：远端与本地模型并行打分，此 key 参与对照'
              : undefined}
        onSave={async (key) => {
          const next = await saveAiSettings({ jev_key: key });
          setInfo(next);
        }}
        onTest={async () => (await testAiSettings('jev')).jev ?? { ok: false, error: '没有返回结果' }}
      />
    </div>
  );
}

function KeyRow({
  title,
  hintText,
  hintUrl,
  placeholder,
  status,
  sourceNote,
  disabledNote,
  canClear,
  onSave,
  onTest,
}: {
  title: string;
  canClear: boolean;
  hintText: string;
  hintUrl: string;
  placeholder: string;
  status?: AiKeyStatusDTO;
  sourceNote?: boolean;
  disabledNote?: string;
  onSave: (key: string) => Promise<void>;
  onTest: () => Promise<{ ok: boolean; error?: string }>;
}) {
  const toast = useToast();
  const [key, setKey] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const configured = status?.configured === true;

  useEffect(() => {
    if (status !== undefined && !status.configured) setEditing(true);
  }, [status]);

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (busy) return;
    const k = key.trim();
    if (!k) {
      toast('请先填写 API Key', 'error');
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      await onSave(k);
      setKey('');
      setEditing(false);
      const r = await onTest();
      setResult(r);
      toast(r.ok ? '已保存，连接正常' : '已保存，但连接测试没通过');
    } catch (e) {
      toastError(toast, e);
    } finally {
      setBusy(false);
    }
  }

  async function onClear() {
    if (busy) return;
    setBusy(true);
    try {
      await onSave(''); // 后端约定：jev_key 传空串 = 清除
      setResult(null);
      setEditing(true);
      toast('已清除');
    } catch (e) {
      toastError(toast, e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        {disabledNote && <span className="text-xs text-slate-400">{disabledNote}</span>}
      </div>

      {configured && !editing ? (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-3 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm">
            <span className="text-emerald-700">
              已接入 · <span className="font-mono">{mask(status!)}</span>
              {sourceNote && <span className="ml-1 text-emerald-600/70">（来自 .env）</span>}
            </span>
            <button type="button" onClick={() => setEditing(true)} className="shrink-0 font-medium text-slate-600 hover:underline">
              更换
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3">
            {canClear && (
              <button
                type="button"
                onClick={() => void onClear()}
                disabled={busy}
                className="text-xs text-slate-400 underline hover:text-slate-600 disabled:opacity-60"
              >
                清除
              </button>
            )}
            {result && (
              <span className={`text-xs ${result.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                {result.ok ? '连接正常' : (result.error ?? '连接失败')}
              </span>
            )}
          </div>
        </div>
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} className="mt-3">
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={placeholder}
            aria-label={title}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm outline-none focus:border-slate-500"
          />
          <p className="mt-1.5 text-xs text-slate-400">
            <a href={hintUrl} target="_blank" rel="noreferrer" className="underline">
              {hintText}
            </a>
            。只保存在这台电脑上。
          </p>
          <div className="mt-3 flex items-center justify-end gap-2">
            {configured && (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setKey('');
                }}
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
          {result && (
            <p className={`mt-2 text-xs ${result.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
              {result.ok ? '连接正常' : (result.error ?? '连接失败')}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

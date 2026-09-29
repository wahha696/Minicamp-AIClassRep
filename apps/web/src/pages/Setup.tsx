// /setup 首次配置向导（修复计划 3.2）：两步 ——
//   ① DeepSeek API Key（必填，保存后真实校验一次）
//   ② 去 /connect 扫码登录 QQ
// 快判走本地模型，无远端 key 步骤；Jev 已淘汰（仅保留服务端对照用接口）。
// FirstRunGuard 在 first_run（没有 uin 或 DeepSeek 未配置）时把用户拦到这里。
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAiSettings, saveAiSettings, testAiSettings } from '../api/client';
import { useToast } from '../components/Toast';
import { toastError } from '../lib/errors';
import { SKIP_CONNECT_KEY, writeAccountFlag } from '../lib/status';

export default function Setup() {
  // 0 = 读取中：已配过 DeepSeek 时直接续到第 2 步，别让用户以为 key 没存上又被弹回来
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    void getAiSettings()
      .then((s) => {
        if (alive) setStep(s.deepseek.configured ? 2 : 1);
      })
      .catch(() => {
        if (alive) setStep(1);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center px-4 py-10">
      <header className="mb-6 text-center">
        <h1 className="text-2xl font-bold text-slate-900">欢迎使用 AI 课代表</h1>
        <p className="mt-1 text-sm text-slate-400">{step === 0 ? '正在读取配置…' : `第 ${step} 步 / 共 2 步`}</p>
      </header>

      {step === 1 && (
        <KeyStep
          title="① 填 DeepSeek API Key"
          desc="群消息靠它整理成日程，必填。"
          placeholder="sk-..."
          helpUrl="https://platform.deepseek.com/api_keys"
          helpText="在 DeepSeek 开放平台创建"
          required
          onDone={() => setStep(2)}
        />
      )}
      {step === 2 && (
        <Panel>
          <div className="text-center">
            <div className="text-4xl" aria-hidden>🎉</div>
            <p className="mt-3 text-lg font-medium text-slate-800">AI 配好了，最后一步：登录 QQ</p>
            <p className="mt-1 text-sm text-slate-400">用手机 QQ 扫码，课代表就开始收群消息</p>
            <button
              type="button"
              onClick={() => navigate('/connect')}
              className="mt-6 w-full rounded-xl bg-slate-900 py-3 text-base font-medium text-white hover:bg-slate-700"
            >
              去扫码登录 →
            </button>
            <button
              type="button"
              onClick={() => {
                writeAccountFlag(SKIP_CONNECT_KEY, '1');
                navigate('/demo');
              }}
              className="mt-3 w-full text-sm text-slate-400 underline-offset-4 hover:text-slate-600 hover:underline"
            >
              暂不扫码，先逛逛演示模式
            </button>
          </div>
        </Panel>
      )}
    </div>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-slate-200 bg-white px-6 py-8 shadow-sm">{children}</div>;
}

function KeyStep({
  title,
  desc,
  placeholder,
  helpUrl,
  helpText,
  required,
  onDone,
}: {
  title: string;
  desc: string;
  placeholder: string;
  helpUrl: string;
  helpText: string;
  required?: boolean;
  onDone: () => void;
}) {
  const toast = useToast();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (busy) return;
    const k = key.trim();
    if (!k) {
      if (required) {
        toast('这个 Key 必填，先填上再继续', 'error');
        return;
      }
      onDone(); // 可选步骤空提交 = 跳过
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      // 先存（格式校验在服务端做），再真实连一次——无效 key 不放行
      await saveAiSettings({ deepseek_key: k });
      const r = await testAiSettings('deepseek');
      const res = r.deepseek ?? { ok: false, error: '没有返回结果' };
      setResult(res);
      if (res.ok) {
        toast('已保存，连接正常');
        onDone();
      } else {
        toast('Key 已保存，但连接测试没通过，请检查后再试', 'error');
      }
    } catch (e) {
      toastError(toast, e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel>
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <p className="mt-1 text-sm text-slate-500">{desc}</p>
      <form onSubmit={(e) => void onSubmit(e)} className="mt-5">
        <input
          type="password"
          autoComplete="off"
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={placeholder}
          aria-label={title}
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 font-mono text-sm outline-none focus:border-slate-500"
        />
        <p className="mt-1.5 text-xs text-slate-400">
          <a href={helpUrl} target="_blank" rel="noreferrer" className="underline">
            {helpText}
          </a>
          。只保存在这台电脑上。
        </p>
        {result && !result.ok && <p className="mt-2 text-xs text-rose-600">{result.error ?? '连接失败'}</p>}
        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-xl bg-slate-900 px-6 py-2.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
          >
            {busy ? '校验中…' : required ? '测试并继续' : key.trim() ? '测试并继续' : '下一步'}
          </button>
        </div>
      </form>
    </Panel>
  );
}

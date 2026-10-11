// 首次引导与设置共用 AI 表单，支持 DeepSeek 和自定义 OpenAI 兼容接口。
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAiSettings } from '../api/client';
import AiSettingsCard from '../components/AiSettingsCard';
import { SKIP_CONNECT_KEY, writeAccountFlag } from '../lib/status';
import { useAccess } from '../components/ConnectStatus';

export default function Setup() {
  // 0 = 读取中：已配过任意 AI 服务 时直接续到第 2 步，别让用户以为 key 没存上又被弹回来
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [tested, setTested] = useState(false);
  const { demoAvailable } = useAccess();
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
        <section aria-label="配置 AI 服务">
          <h2 className="mb-2 text-lg font-semibold text-slate-900">① 配置 AI 服务</h2>
          <p className="mb-4 text-sm text-slate-500">选择 DeepSeek 或自定义 OpenAI 兼容服务，用于把群消息整理成日程。</p>
          <AiSettingsCard submitLabel="测试并继续" onConfigured={() => { setTested(true); setStep(2); }} />
        </section>
      )}
      {step === 2 && (
        <Panel>
          <div className="text-center">
            <div className="text-4xl" aria-hidden>🎉</div>
            <p className="mt-3 text-lg font-medium text-slate-800">{tested ? 'API Key 检查通过，接下来连接账号' : '已有 AI 配置，接下来连接账号'}</p>
            <p className="mt-1 text-sm text-slate-400">{tested ? '鉴权检查通过不代表每次整理都能成功。' : '保存过配置不代表连接正常，可在设置中检查。'}连接 QQ 或受支持的电脑微信后自动进入空间，在群管理中选择群。</p>
            <button
              type="button"
              onClick={() => navigate('/connect')}
              className="mt-6 w-full rounded-xl bg-slate-900 py-3 text-base font-medium text-white hover:bg-slate-700"
            >
              去连接账号 →
            </button>
            {demoAvailable && <button
              type="button"
              onClick={() => {
                writeAccountFlag(SKIP_CONNECT_KEY, '1');
                navigate('/demo');
              }}
              className="mt-3 w-full text-sm text-slate-400 underline-offset-4 hover:text-slate-600 hover:underline"
            >
              暂不扫码，先逛逛演示模式
            </button>}
          </div>
        </Panel>
      )}
    </div>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-slate-200 bg-white px-6 py-8 shadow-sm">{children}</div>;
}

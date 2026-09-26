// 演示控制台 /demo（D7，FR-11）：剧本回放、清空演示数据、粘贴聊天记录、流水线统计。
import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getHealth, getScenarios, importText, replay, resetDemo, undoReplay } from '../api/client';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { usePolling } from '../hooks/usePolling';
import { toastError } from '../lib/errors';

export default function Demo() {
  const scenarios = usePolling(getScenarios, 30_000);
  const health = usePolling(getHealth, 5_000);
  const toast = useToast();

  const [replaying, setReplaying] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [text, setText] = useState('');
  const [importing, setImporting] = useState(false);

  async function onReplay(name: string) {
    setReplaying(name);
    try {
      const r = await replay(name);
      toast(`已注入 ${r.injected} 条消息`);
      void health.refresh();
      void scenarios.refresh();
    } catch (e) {
      toastError(toast, e);
    } finally {
      setReplaying(null);
    }
  }

  async function onUndo(name: string) {
    setReplaying(name);
    try {
      await undoReplay(name);
      toast('已取消，这个剧本的假数据已删除');
      void scenarios.refresh();
    } catch (e) {
      toastError(toast, e);
    } finally {
      setReplaying(null);
    }
  }

  async function onReset() {
    setResetting(true);
    try {
      await resetDemo();
      toast('已清空演示数据');
      setConfirmReset(false);
      void health.refresh();
      void scenarios.refresh();
    } catch (e) {
      toastError(toast, e);
    } finally {
      setResetting(false);
    }
  }

  async function onImport(ev: FormEvent) {
    ev.preventDefault();
    if (!groupName.trim() || !text.trim()) {
      toast('群名和聊天记录都不能为空', 'error');
      return;
    }
    setImporting(true);
    try {
      const r = await importText(groupName.trim(), text);
      toast(`已导入 ${r.messages} 条消息`);
      setText('');
      void health.refresh();
    } catch (e) {
      toastError(toast, e);
    } finally {
      setImporting(false);
    }
  }

  const cancelReset = useCallback(() => setConfirmReset(false), []);
  const h = health.data;

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">演示控制台</h1>
        <p className="mt-2 text-sm text-slate-500">
          没有 QQ 也能演示：回放仿真群聊，AI 会把通知整理进
          <Link to="/" className="mx-1 text-slate-800 underline underline-offset-2">
            今日
          </Link>
          和
          <Link to="/week" className="mx-1 text-slate-800 underline underline-offset-2">
            本周
          </Link>
          。
        </p>
      </div>

      {/* 统计卡（FR-3.2） */}
      <div className="grid grid-cols-2 gap-3">
        <Stat label="累计过滤" value={h?.filtered_count} unit="条" hint="规则与 Jev 合计" />
        <Stat label="Jev 快判过滤" value={h?.jev_filtered_count} unit="条" hint="本次启动后 Jev 判断为无日程信息的消息" />
        <Stat label="Jev 累计调用" value={h?.jev_called_count} unit="次" hint="每批候选消息一起判断" />
        <Stat label="AI 累计调用" value={h?.llm_called_count} unit="次" hint="快判保留的消息交给 AI 提取日程" />
      </div>

      <Card title="回放剧本">
        {scenarios.error && !scenarios.data && <p className="text-sm text-rose-600">{scenarios.error.message}</p>}
        {scenarios.loading && <div className="h-12 animate-pulse rounded-lg bg-slate-100" />}
        {scenarios.data && scenarios.data.length === 0 && <p className="text-sm text-slate-400">没有可用的剧本</p>}
        {scenarios.data && scenarios.data.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {scenarios.data.map((s) => (
              <li key={s.name} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-slate-800">{s.title}</div>
                  <div className="text-xs text-slate-400">
                    {s.name} · {s.count} 条消息
                    {s.active && <span className="ml-1.5 text-emerald-600">· 已回放，点「取消」删掉这批假数据</span>}
                  </div>
                </div>
                {s.active ? (
                  <button
                    type="button"
                    onClick={() => void onUndo(s.name)}
                    disabled={replaying !== null}
                    className="shrink-0 rounded-lg border border-rose-200 px-3 py-1.5 text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-60"
                  >
                    {replaying === s.name ? '取消中…' : '取消'}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void onReplay(s.name)}
                    disabled={replaying !== null}
                    className="flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
                  >
                    {replaying === s.name && (
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    )}
                    {replaying === s.name ? '回放中…' : '回放'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="粘贴聊天记录">
        <form onSubmit={(e) => void onImport(e)} className="space-y-3">
          <input
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="群名，如：高数(2)班"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
          />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder={'把 QQ 里复制的聊天记录粘贴到这里，例如：\n张老师 10:02:11\n@全体成员 明天下午两点 A301 随堂小测'}
            className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm outline-none focus:border-slate-500"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={importing}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
            >
              {importing ? '提交中…' : '提交'}
            </button>
          </div>
        </form>
      </Card>

      <Card title="重置">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-500">删除所有演示群及其消息和日程，真实群的数据不受影响。</p>
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="rounded-lg border border-rose-200 px-3 py-1.5 text-sm text-rose-600 hover:bg-rose-50"
          >
            清空演示数据
          </button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmReset}
        title="清空演示数据？"
        confirmText="清空"
        danger
        busy={resetting}
        onConfirm={() => void onReset()}
        onCancel={cancelReset}
      >
        将删除所有演示群的消息和日程，可以重新回放。
      </ConfirmDialog>
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-base font-semibold text-slate-800">{title}</h2>
      {children}
    </div>
  );
}

function Stat({ label, value, unit, hint }: { label: string; value: number | undefined; unit: string; hint: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 text-3xl font-bold tabular-nums text-slate-900">
        {value ?? '–'}
        <span className="ml-1 text-sm font-normal text-slate-400">{unit}</span>
      </div>
      <div className="mt-1 text-xs text-slate-400">{hint}</div>
    </div>
  );
}

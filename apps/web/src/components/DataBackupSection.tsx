import { useRef, useState } from 'react';
import {
  downloadDataBackup,
  downloadDiagnosticReport,
  getDataBackupStatus,
  restoreDataBackup,
} from '../api/client';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from './Toast';
import { usePolling } from '../hooks/usePolling';
import { toastError } from '../lib/errors';

function timeText(value: number | null): string {
  if (value === null) return '暂无';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

export default function DataBackupSection() {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const { data, refresh } = usePolling(getDataBackupStatus, 30_000);
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [selected, setSelected] = useState<File | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function onExport() {
    setExporting(true);
    try {
      const { blob, filename } = await downloadDataBackup();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      toast('账号数据备份已下载');
      await refresh();
    } catch (error) {
      toastError(toast, error);
    } finally {
      setExporting(false);
    }
  }

  async function onRestore() {
    if (!selected) return;
    setRestoring(true);
    try {
      await restoreDataBackup(selected);
      setConfirming(false);
      setSelected(null);
      if (input.current) input.current.value = '';
      toast('备份已恢复；恢复前的数据也已自动保留');
      await refresh();
    } catch (error) {
      toastError(toast, error);
    } finally {
      setRestoring(false);
    }
  }

  async function onDiagnostic() {
    setDiagnosing(true);
    try {
      const { blob, filename } = await downloadDiagnosticReport();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      toast('脱敏诊断报告已下载');
    } catch (error) {
      toastError(toast, error);
    } finally {
      setDiagnosing(false);
    }
  }

  return (
    <section className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-slate-800">账号数据备份</h3>
          <p className="mt-1 text-sm leading-relaxed text-slate-500">
            导出当前账号的日程、消息、课表、待办和记忆。API Key 不在账号数据库中，不会写进备份。
          </p>
          <p className="mt-2 text-xs text-slate-400">
            每日自动快照 {data?.automatic_count ?? 0} 份 · 最近 {timeText(data?.latest_automatic_at ?? null)}
          </p>
        </div>
        <button
          type="button"
          disabled={exporting || restoring}
          onClick={() => void onExport()}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {exporting ? '正在生成…' : '导出备份'}
        </button>
      </div>

      <div className="mt-4 border-t border-slate-100 pt-4">
        <label className="block text-sm font-medium text-slate-700" htmlFor="data-backup-file">恢复备份</label>
        <p className="mt-1 text-xs text-slate-500">
          只接受 ClassRep 备份文件。恢复前会校验哈希与数据库完整性，并自动保存当前数据库。
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            ref={input}
            id="data-backup-file"
            type="file"
            accept=".classrep-backup,application/octet-stream"
            disabled={restoring}
            onChange={(event) => {
              setSelected(event.target.files?.[0] ?? null);
              setConfirming(false);
            }}
            className="min-w-0 flex-1 text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm"
          />
          {selected && (
            <button
              type="button"
              disabled={restoring}
              onClick={() => setConfirming(true)}
              className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-700 disabled:opacity-60"
            >
              {restoring ? '正在恢复…' : '恢复此备份'}
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-slate-500">
          诊断报告解释最近消息为何被规则过滤、快判丢弃、未识别、生成日程或进入待确认；不包含消息正文、群号、QQ 号、姓名、路径或 API Key。
        </p>
        <button
          type="button"
          disabled={diagnosing || restoring}
          onClick={() => void onDiagnostic()}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60"
        >
          {diagnosing ? '正在生成…' : '下载脱敏诊断'}
        </button>
      </div>

      <ConfirmDialog
        open={confirming && selected !== null}
        title="恢复账号数据？"
        confirmText="确认恢复"
        danger
        busy={restoring}
        onConfirm={() => void onRestore()}
        onCancel={() => {
          setConfirming(false);
        }}
      >
        当前账号数据库会先自动备份，再替换为所选备份。恢复过程中不要关闭启动窗口。
      </ConfirmDialog>
    </section>
  );
}

// 设置页里的「课表」一栏（FR-13，原 /timetable 页）：
// ① 从中南教务系统一键导入（csujwc 直连，校园网）：学号/密码 → 验证码 → 服务端拉课表；
// ② xls 文件导入：浏览器端解析（SheetJS 按需动态加载，不进首屏包），原始文件不上传服务器。
// 两种来源都进「预览网格 + warnings → 确认保存」流程；已有课表时可「清空」（二次确认）。
import { useRef, useState } from 'react';
import {
  clearTimetable,
  csuFetchCourses,
  csuStartImport,
  getTimetable,
  getTimetableVersions,
  restoreTimetable,
} from '../api/client';
import type { TimetableDTO, TimetableVersion } from '../../../../shared/timetable';
import TimetableEditor from './TimetableEditor';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { usePolling } from '../hooks/usePolling';
import { toastError } from '../lib/errors';
import { parseTimetable, type ParsedTimetable } from '../lib/timetable';

async function parseFile(file: File): Promise<{ name: string; result: ParsedTimetable }[]> {
  if (file.size > 10 * 1024 * 1024) throw new Error('课表文件不能超过 10 MB');
  const XLSX = await import('xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]!;
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
    if (range.e.r > 10000 || range.e.c > 200) throw new Error('工作表范围过大，请只导出课表部分');
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '', raw: false });
    return { name, result: parseTimetable(rows, { sheet: name, merges: ws['!merges'] }) };
  });
}

export default function TimetableSection() {
  const { data, loading, refresh } = usePolling(getTimetable, 60_000);
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = useState(false);
  const [draft, setDraft] = useState<ParsedTimetable | null>(null); // 待确认的解析结果
  const [sheets, setSheets] = useState<{ name: string; result: ParsedTimetable }[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [baseline, setBaseline] = useState<TimetableDTO | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [versions, setVersions] = useState<TimetableVersion[] | null>(null);
  const [restoreChoice, setRestoreChoice] = useState<TimetableVersion | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmedRevision, setConfirmedRevision] = useState(0);
  const [clearing, setClearing] = useState(false);

  // 教务系统(csujwc)直连导入状态:学号/密码只在本组件内存里,保存前即清空
  const [csuOpen, setCsuOpen] = useState(false);
  const [csuUser, setCsuUser] = useState('');
  const [csuPass, setCsuPass] = useState('');
  const [csuSession, setCsuSession] = useState(''); // 服务端挂起会话(验证码绑定)
  const [csuCaptcha, setCsuCaptcha] = useState(''); // 验证码图片 data URL
  const [csuCode, setCsuCode] = useState('');
  const [csuBusy, setCsuBusy] = useState<'' | 'captcha' | 'fetch'>('');
  const [csuErr, setCsuErr] = useState('');

  const saved = data ?? null;
  const hasSaved = (saved?.courses.length ?? 0) > 0;

  async function onFile(file: File | undefined) {
    if (!file) return;
    setParsing(true);
    try {
      const results = await parseFile(file);
      if (!results.length) throw new Error('文件里没有工作表');
      setSheets(results);
      setSheetIndex(0);
      setEditing(false);
      setBaseline(saved);
      setEditorKey((k) => k + 1);
      const parsed = results[0]!.result;
      setDraft(parsed);
      if (parsed.courses.length === 0) {
        toast('没解析出课程，看看 warnings', 'error');
      }
    } catch (e) {
      // 本地解析失败（不是接口错误），只给一条友好提示，不再叠一条原始报错
      toast(e instanceof Error ? e.message : '读不出来这个文件，确认是教务系统导出的课表 xls/xlsx', 'error');
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function onClear() {
    setClearing(true);
    try {
      await clearTimetable(confirmedRevision);
      toast('课表已清空');
      setConfirmClear(false);
      await refresh();
    } catch (e) {
      toastError(toast, e);
    } finally {
      setClearing(false);
    }
  }

  /** 第一步:拿验证码(服务端同时建立教务网会话,密钥留在服务端内存) */
  async function onCsuCaptcha() {
    if (!csuUser.trim() || !csuPass) {
      setCsuErr('先填学号和密码');
      return;
    }
    setCsuBusy('captcha');
    setCsuErr('');
    try {
      const started = await csuStartImport(csuUser.trim(), csuPass);
      setCsuSession(started.session_id);
      setCsuCaptcha(started.captcha);
      setCsuCode('');
    } catch (e) {
      setCsuSession('');
      setCsuCaptcha('');
      setCsuErr(e instanceof Error ? e.message : '获取验证码失败');
    } finally {
      setCsuBusy('');
    }
  }

  /** 第二步:验证码(如需)+ 完成 CAS 登录 + 拉课表解析,进「预览 → 确认保存」流程(与文件导入一致) */
  async function onCsuFetch() {
    if (!csuSession || (csuCaptcha && !csuCode.trim())) {
      setCsuErr('先获取验证码,再输入图片里的字符');
      return;
    }
    setCsuBusy('fetch');
    setCsuErr('');
    try {
      const parsed = await csuFetchCourses(csuSession, csuCode.trim());
      const tableNames = [...new Set(parsed.items?.map((i) => i.sheet) ?? [])];
      const alternatives = tableNames.map((name) => ({
        name,
        result: {
          ...parsed,
          courses: parsed.courses.filter((c) => c.source?.sheet === name),
          items: parsed.items?.filter((i) => i.sheet === name),
        },
      }));
      setDraft(alternatives.length > 1 ? alternatives[0]!.result : parsed);
      setSheets(alternatives.length > 1 ? alternatives : []);
      setSheetIndex(0);
      setEditing(false);
      setBaseline(saved);
      setEditorKey((k) => k + 1);
      // 账号密码用完即清,不留在界面上
      setCsuPass('');
      setCsuSession('');
      setCsuCaptcha('');
      setCsuCode('');
      setCsuOpen(false);
      if (parsed.courses.length === 0) {
        toast('教务系统里没解析出课程,看看 warnings', 'error');
      } else {
        toast(`已从教务系统拉到 ${parsed.courses.length} 个课次,核对后保存`);
      }
    } catch (e) {
      // 验证码是一次性的:失败后这次会话就作废,要重新获取
      setCsuSession('');
      setCsuCaptcha('');
      setCsuCode('');
      setCsuErr(e instanceof Error ? e.message : '导入失败');
    } finally {
      setCsuBusy('');
    }
  }

  return (
    <section id="timetable">
      <h2 className="text-lg font-semibold text-slate-900">课表</h2>
      <p className="mt-1 text-sm text-slate-500">
        两种导入:① 电脑连着校园网时,用教务系统学号一键拉取(下面);② 教务系统导出的 xls
        文件(浏览器本地解析,不上传)。
      </p>

      {/* 教务系统(csujwc)直连导入 */}
      <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-700">从中南大学教务系统一键导入</p>
            <p className="mt-1 text-xs text-slate-400">
              用统一身份认证的学号和密码(信息门户那套)→ 看图输验证码(需要时) →
              自动拉课表。密码只用于本次登录,不保存。
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setCsuOpen((v) => !v);
              setCsuErr('');
            }}
            className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
          >
            {csuOpen ? '收起' : '使用教务账号导入'}
          </button>
        </div>

        {csuOpen && (
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-600">
                学号
                <input
                  type="text"
                  value={csuUser}
                  disabled={csuBusy !== ''}
                  autoComplete="off"
                  onChange={(e) => {
                    setCsuUser(e.target.value);
                    setCsuSession('');
                    setCsuCaptcha('');
                    setCsuCode('');
                    setCsuErr('');
                  }}
                  className="w-40 rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-600">
                密码
                <input
                  type="password"
                  value={csuPass}
                  disabled={csuBusy !== ''}
                  autoComplete="off"
                  onChange={(e) => {
                    setCsuPass(e.target.value);
                    setCsuSession('');
                    setCsuCaptcha('');
                    setCsuCode('');
                    setCsuErr('');
                  }}
                  className="w-40 rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                />
              </label>
              <button
                type="button"
                onClick={() => void onCsuCaptcha()}
                disabled={csuBusy !== '' || !csuUser.trim() || !csuPass}
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
              >
                {csuBusy === 'captcha' ? '获取中…' : '下一步'}
              </button>
            </div>

            {csuSession && !csuCaptcha && (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-xs text-slate-500">本次登录不需要验证码,直接点「登录并导入」。</p>
                <button
                  type="button"
                  onClick={() => void onCsuFetch()}
                  disabled={csuBusy !== ''}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
                >
                  {csuBusy === 'fetch' ? '导入中…' : '登录并导入'}
                </button>
              </div>
            )}

            {csuSession && csuCaptcha && (
              <div className="flex flex-wrap items-center gap-3">
                <img
                  src={csuCaptcha}
                  alt="统一身份认证验证码"
                  className="h-10 rounded-lg border border-slate-200 bg-white"
                />
                <button
                  type="button"
                  onClick={() => void onCsuCaptcha()}
                  disabled={csuBusy !== ''}
                  className="text-xs text-slate-500 underline hover:text-slate-700 disabled:opacity-60"
                >
                  换一张
                </button>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  验证码
                  <input
                    type="text"
                    value={csuCode}
                    maxLength={10}
                    autoComplete="off"
                    onChange={(e) => {
                      setCsuCode(e.target.value);
                      setCsuErr('');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) void onCsuFetch();
                    }}
                    className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void onCsuFetch()}
                  disabled={csuBusy !== '' || !csuCode.trim()}
                  className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
                >
                  {csuBusy === 'fetch' ? '导入中…' : '登录并导入'}
                </button>
              </div>
            )}

            {csuErr && <p className="text-xs text-rose-600">{csuErr}</p>}
            <p className="text-xs text-slate-400">
              拉取后同样先预览、填「第一周周一」再保存;验证码错了点「换一张」重来即可;多次密码错误后统一身份认证会强制要求验证码。
            </p>
          </div>
        )}
      </div>

      {/* 当前课表概况 */}
      {!loading && hasSaved && !draft && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-700">
            当前课表：第一周周一 <span className="font-medium">{saved!.semester_start}</span>， 共{' '}
            <span className="font-medium">{saved!.courses.length}</span> 个课次。
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              重新导入
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmedRevision(saved?.revision ?? 0);
                setConfirmClear(true);
              }}
              className="rounded-lg border border-rose-200 px-3 py-2 text-sm text-rose-600 hover:bg-rose-50"
            >
              清空课表
            </button>
          </div>
        </div>
      )}

      {/* 没有课表时的引导 */}
      {!loading && !hasSaved && !draft && (
        <div className="mt-3 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-8 text-center">
          <p className="text-lg font-medium text-slate-700">还没有课表</p>
          <p className="mt-2 text-sm text-slate-400">选一个教务系统导出的课表文件（xls / xlsx）</p>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={parsing}
            className="mt-6 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
          >
            {parsing ? '解析中…' : '选择课表文件'}
          </button>
        </div>
      )}

      {loading && <div className="mt-3 h-24 animate-pulse rounded-xl bg-slate-200/60" aria-busy />}

      {/* 隐藏的文件选择器 */}
      <input
        ref={fileRef}
        type="file"
        accept=".xls,.xlsx"
        className="hidden"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />

      {/* 解析预览 + 确认 */}
      <div className="mt-3 flex flex-wrap gap-2">
        {!hasSaved && (
          <button
            className="rounded border px-3 py-2 text-sm"
            onClick={() => {
              setDraft({ courses: [], warnings: [] });
              setBaseline(saved);
              setEditing(true);
              setSheets([]);
              setEditorKey((k) => k + 1);
            }}
          >
            手动创建课表
          </button>
        )}
        {hasSaved && (
          <button
            className="rounded border px-3 py-2 text-sm"
            onClick={() => {
              setDraft({ courses: saved!.courses, warnings: [], items: saved!.import_items });
              setBaseline(saved);
              setEditing(true);
              setSheets([]);
              setEditorKey((k) => k + 1);
            }}
          >
            编辑课程、作息与单次调课
          </button>
        )}
        <button
          className="rounded border px-3 py-2 text-sm"
          onClick={() =>
            void getTimetableVersions()
              .then(setVersions)
              .catch((e) => toastError(toast, e))
          }
        >
          查看可恢复版本（最近 20 个）
        </button>
      </div>
      {versions && (
        <div className="mt-3 space-y-2 rounded border p-3 text-sm">
          <h3>可恢复版本</h3>
          {!versions.length && <p>暂无旧版本；每次保存、清空、恢复前都会保留上一版。</p>}
          {versions.map((v) => (
            <div key={v.id} className="flex flex-wrap items-center gap-2">
              <span>
                {new Date(v.created_at).toLocaleString()} · {v.reason}前 · {v.timetable.courses.length} 条规则
              </span>
              <button
                className="rounded border px-2 py-1"
                onClick={() => {
                  setConfirmedRevision(saved?.revision ?? 0);
                  setRestoreChoice(v);
                }}
              >
                恢复此版本
              </button>
            </div>
          ))}
        </div>
      )}
      {sheets.length > 1 && draft && (
        <label className="mt-4 block text-sm">
          选择工作表（不会自动丢弃或合并其他 sheet）
          <select
            className="ml-2 rounded border p-2"
            value={sheetIndex}
            onChange={(e) => {
              const i = Number(e.target.value);
              setSheetIndex(i);
              setDraft(sheets[i]!.result);
              setEditorKey((k) => k + 1);
            }}
          >
            {sheets.map((s, i) => (
              <option key={s.name} value={i}>
                {s.name} · {s.result.courses.length} 条规则 ·{' '}
                {s.result.items?.filter((x) => x.status === 'pending').length ?? 0} 待确认
              </option>
            ))}
          </select>
        </label>
      )}
      {draft && (
        <TimetableEditor
          key={editorKey}
          parsed={draft}
          saved={baseline}
          editing={editing}
          onCancel={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            setVersions(null);
            toast('课表已保存；原始对账与上一版本已保留');
            void refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={!!restoreChoice}
        title="恢复此课表版本？"
        confirmText="确认恢复"
        onCancel={() => setRestoreChoice(null)}
        onConfirm={() => {
          if (restoreChoice)
            void restoreTimetable(restoreChoice.id, confirmedRevision)
              .then(() => {
                setRestoreChoice(null);
                setDraft(null);
                setVersions(null);
                void refresh();
                toast('课表已恢复；恢复前版本也已保留');
              })
              .catch((e) => toastError(toast, e));
        }}
      >
        这会替换当前课程、作息和调课例外；恢复前状态仍可撤销。
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmClear}
        title="清空课表？"
        confirmText="清空"
        danger
        focusCancel
        busy={clearing}
        onConfirm={() => void onClear()}
        onCancel={() => setConfirmClear(false)}
      >
        将清空已保存课程；操作前会保留可恢复版本。群与课程绑定不受影响。
      </ConfirmDialog>
    </section>
  );
}

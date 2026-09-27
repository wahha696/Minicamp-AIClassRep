// 设置页里的「课表」一栏（FR-13，原 /timetable 页）：导入教务系统 xls 课表 → 预览网格 + warnings → 确认保存。
// 解析在浏览器里做（SheetJS 按需动态加载，不进首屏包），原始文件不上传服务器。
// 已有课表时可「重新导入」「清空」（二次确认，默认焦点在取消）。
import { useRef, useState } from 'react';
import { clearTimetable, getTimetable, saveTimetable } from '../api/client';
import type { CourseDTO } from '../api/types';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import WeekGrid from '../components/WeekGrid';
import { usePolling } from '../hooks/usePolling';
import { toastError } from '../lib/errors';
import { parseTimetable, type ParsedTimetable } from '../lib/timetable';

const DAY = 86_400_000;
const TZ = 8 * 3_600_000;
// 预览网格的基准周：显示「第 1 周」七天（2026-09-07 起），列头只作占位
const PREVIEW_MONDAY = Date.parse('2026-09-07T00:00:00+08:00');

const DEFAULT_SEMESTER_START = '2026-09-07';

/** 'YYYY-MM-DD' 是不是周一（上海时区） */
function isMonday(dateStr: string): boolean {
  const t = Date.parse(`${dateStr}T00:00:00+08:00`);
  if (Number.isNaN(t)) return false;
  return new Date(t + TZ).getUTCDay() === 1;
}

async function parseFile(file: File): Promise<ParsedTimetable> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]!];
  if (!ws) return { courses: [], warnings: ['文件里没有工作表'] };
  const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
  return parseTimetable(rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c)))));
}

export default function TimetableSection() {
  const { data, loading, refresh } = usePolling(getTimetable, 60_000);
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsing, setParsing] = useState(false);
  const [draft, setDraft] = useState<ParsedTimetable | null>(null); // 待确认的解析结果
  const [semesterStart, setSemesterStart] = useState('');
  const [startErr, setStartErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const saved = data ?? null;
  const hasSaved = (saved?.courses.length ?? 0) > 0;

  async function onFile(file: File | undefined) {
    if (!file) return;
    setParsing(true);
    try {
      const parsed = await parseFile(file);
      setDraft(parsed);
      setSemesterStart(parsed.semesterStart || saved?.semester_start || DEFAULT_SEMESTER_START);
      if (parsed.courses.length === 0) {
        toast('没解析出课程，看看 warnings', 'error');
      }
    } catch (e) {
      toastError(toast, e);
      toast('读不出来这个文件，确认是教务系统导出的课表 xls/xlsx', 'error');
    } finally {
      setParsing(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function onSave() {
    if (!draft) return;
    if (!isMonday(semesterStart)) {
      setStartErr('「第一周周一」必须是一个周一（上海时区）');
      return;
    }
    setStartErr('');
    setSaving(true);
    try {
      await saveTimetable({ semester_start: semesterStart, courses: draft.courses });
      toast(`课表已保存：${draft.courses.length} 个课次`);
      setDraft(null);
      await refresh();
    } catch (e) {
      toastError(toast, e);
    } finally {
      setSaving(false);
    }
  }

  async function onClear() {
    setClearing(true);
    try {
      await clearTimetable();
      toast('课表已清空');
      setConfirmClear(false);
      await refresh();
    } catch (e) {
      toastError(toast, e);
    } finally {
      setClearing(false);
    }
  }

  // 预览网格：把解析出的课程全部塞进去（不按周数过滤，便于人工核对）
  const previewDays = Array.from({ length: 7 }, (_, i) => ({
    from: PREVIEW_MONDAY + i * DAY,
    isToday: false,
  }));
  const previewCourses: CourseDTO[] = draft?.courses ?? [];

  return (
    <section id="timetable">
      <h2 className="text-lg font-semibold text-slate-900">课表</h2>
      <p className="mt-1 text-sm text-slate-500">
        从教务系统导出的课表（xls / xlsx），在浏览器里解析后直接保存——原始文件不会上传。
      </p>

      {/* 当前课表概况 */}
      {!loading && hasSaved && !draft && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-700">
            当前课表：第一周周一 <span className="font-medium">{saved!.semester_start}</span>，
            共 <span className="font-medium">{saved!.courses.length}</span> 个课次。
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
              onClick={() => setConfirmClear(true)}
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
      {draft && (
        <div className="mt-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-700">解析结果预览</h2>
            <p className="mt-1 text-xs text-slate-400">
              共 {draft.courses.length} 个课次。课程以灰底显示；核对无误后填「第一周周一」再保存。
            </p>

            {draft.warnings.length > 0 && (
              <ul className="mt-3 space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {draft.warnings.map((w, i) => (
                  <li key={i}>⚠️ {w}</li>
                ))}
              </ul>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-600">
                第一周周一
                <input
                  type="date"
                  value={semesterStart}
                  onChange={(e) => {
                    setSemesterStart(e.target.value);
                    setStartErr('');
                  }}
                  className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
                />
              </label>
              {startErr && <span className="text-xs text-rose-600">{startErr}</span>}
            </div>

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => void onSave()}
                disabled={saving || draft.courses.length === 0}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
              >
                {saving ? '保存中…' : '保存课表'}
              </button>
              <button
                type="button"
                onClick={() => setDraft(null)}
                disabled={saving}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-60"
              >
                放弃
              </button>
            </div>
          </div>

          {/* 只读预览网格：所有课程都显示（不按周过滤），人工核对格子位置对不对 */}
          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
            <WeekGrid days={previewDays} courses={previewCourses} itemsByDay={[]} onPick={() => {}} readonly />
          </div>
        </div>
      )}

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
        将删除已保存的全部课次；群↔课程绑定不受影响（只是不再有课表上下文给 AI）。
      </ConfirmDialog>
    </section>
  );
}

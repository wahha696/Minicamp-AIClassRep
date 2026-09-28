import { useMemo, useState } from 'react';
import { saveTimetable } from '../api/client';
import {
  DEFAULT_BELLS,
  dateStamp,
  dateString,
  DAY,
  normalizeCourses,
  periods,
  reconcileCourses,
  ruleTimes,
  type CourseDTO,
  type ImportItem,
  type TimetableDTO,
  type CourseException,
} from '../../../../shared/timetable';
import { parseWeeks, type ParsedTimetable } from '../../../../shared/timetable-import';
import WeekGrid from './WeekGrid';

const input = 'min-w-0 rounded border border-slate-300 bg-white p-1.5 text-sm';
const button = 'rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40';
function CourseForm({
  course,
  onChange,
  onRemove,
}: {
  course: CourseDTO;
  onChange: (c: CourseDTO) => void;
  onRemove: () => void;
}) {
  const [weeks, setWeeks] = useState(course.weeks.join(','));
  const [a, b] = periods(course);
  const change = (v: Partial<CourseDTO>) => onChange({ ...course, ...v, user_modified: true });
  return (
    <details className="rounded border p-3">
      <summary className="cursor-pointer break-words text-sm">
        {course.name} · 周{'一二三四五六日'[course.weekday - 1]} · {a}–{b} 节 · {course.weeks.join(',')} 周
        {course.user_modified && ' · 人工修改'}
      </summary>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {(['name', 'teacher', 'location', 'campus', 'class_name'] as const).map((key, i) => (
          <label key={key} className="grid gap-1 text-xs">
            {['课程名称', '教师（可空）', '地点（可空）', '校区', '班级'][i]}
            <input
              className={input}
              value={course[key] ?? ''}
              onChange={(e) => change({ [key]: e.target.value })}
            />
          </label>
        ))}
        <label className="grid gap-1 text-xs">
          星期
          <select
            className={input}
            value={course.weekday}
            onChange={(e) => change({ weekday: Number(e.target.value) as CourseDTO['weekday'] })}
          >
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                周{'一二三四五六日'[n - 1]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          开始节次
          <input
            type="number"
            min="1"
            max="24"
            className={input}
            value={a}
            onChange={(e) =>
              change({ start_period: Number(e.target.value), block: Math.ceil(Number(e.target.value) / 2) })
            }
          />
        </label>
        <label className="grid gap-1 text-xs">
          结束节次
          <input
            type="number"
            min="1"
            max="24"
            className={input}
            value={b}
            onChange={(e) => change({ end_period: Number(e.target.value) })}
          />
        </label>
        <label className="grid gap-1 text-xs">
          周次（如 1-16单、2,4,8）
          <input
            className={input}
            value={weeks}
            aria-invalid={!parseWeeks(weeks)}
            onChange={(e) => {
              setWeeks(e.target.value);
              change({ weeks: parseWeeks(e.target.value) ?? [] });
            }}
          />
          {!parseWeeks(weeks) && <span className="text-red-700">周次无效，不能保存</span>}
        </label>
        <label className="grid gap-1 text-xs">
          实际开始（可覆盖作息）
          <input
            type="time"
            className={input}
            value={course.start_time ?? ''}
            onChange={(e) => change({ start_time: e.target.value })}
          />
        </label>
        <label className="grid gap-1 text-xs">
          实际结束（可覆盖作息）
          <input
            type="time"
            className={input}
            value={course.end_time ?? ''}
            onChange={(e) => change({ end_time: e.target.value })}
          />
        </label>
      </div>
      {course.source && (
        <p className="mt-2 text-xs">
          来源：{course.source.sheet} R{course.source.row}C{course.source.column} · 规则 ID：{course.id}
        </p>
      )}
      <button className={`${button} mt-2 text-red-700`} onClick={onRemove}>
        移除此规则（保存前可放弃）
      </button>
    </details>
  );
}

function SourceItem({
  item,
  onResolve,
  onManual,
}: {
  item: ImportItem;
  onResolve: (ignore: boolean, reason: string) => void;
  onManual: () => void;
}) {
  const [reason, setReason] = useState(item.message ?? '');
  return (
    <details className="rounded border p-2 text-sm" open={item.status === 'pending'}>
      <summary className="cursor-pointer">
        {item.sheet} R{item.row}C{item.column} ·{' '}
        {item.status === 'pending' ? '待确认' : item.status === 'ignored' ? '已明确忽略' : '已核对'} ·{' '}
        {item.course_ids.length} 条规则
      </summary>
      <pre className="my-2 whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-xs">{item.raw}</pre>
      <label className="grid gap-1 text-xs">
        核对备注 / 忽略理由
        <input className={input} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        <button className={button} onClick={onManual}>
          从此片段手动补一门
        </button>
        <button
          className={button}
          disabled={!item.course_ids.length}
          onClick={() => onResolve(false, reason)}
        >
          以上关联课程已完整核对
        </button>
        <button className={button} disabled={!reason.trim()} onClick={() => onResolve(true, reason)}>
          明确忽略此片段及关联课程
        </button>
      </div>
    </details>
  );
}

export default function TimetableEditor({
  parsed,
  saved,
  editing = false,
  onSaved,
  onCancel,
}: {
  parsed: ParsedTimetable;
  saved: TimetableDTO | null;
  editing?: boolean;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [courses, setCourses] = useState(() => normalizeCourses(parsed.courses));
  const [items, setItems] = useState(parsed.items ?? []);
  const [start, setStart] = useState(parsed.semesterStart || saved?.semester_start || '');
  const [config, setConfig] = useState({
    term_name: saved?.term_name ?? '',
    school: saved?.school ?? '',
    campus: saved?.campus ?? '',
    term_weeks: saved?.term_weeks ?? 30,
  });
  const [bells, setBells] = useState(saved?.bells ?? DEFAULT_BELLS);
  const [exceptions, setExceptions] = useState(saved?.exceptions ?? []);
  const [mode, setMode] = useState<'merge' | 'replace'>(editing ? 'replace' : 'merge');
  const [confirmed, setConfirmed] = useState(false),
    [confirmLoss, setConfirmLoss] = useState(false);
  const [previewWeek, setPreviewWeek] = useState(1);
  const [error, setError] = useState(''),
    [saving, setSaving] = useState(false);
  const diff = useMemo(() => reconcileCourses(saved?.courses ?? [], courses, mode), [saved, courses, mode]);
  const pending = items.filter((i) => i.status === 'pending').length;
  const termMismatch = mode === 'merge' && !!saved?.courses.length && start !== saved.semester_start;
  const loss =
    mode === 'replace' &&
    !!saved?.courses.length &&
    (courses.length < saved.courses.length * 0.8 || saved.courses.some((c) => c.user_modified));
  const table: TimetableDTO = { ...config, semester_start: start, courses: diff.courses, bells, exceptions };
  const first = dateStamp(start);
  const monday = Number.isFinite(first) ? first + (previewWeek - 1) * 7 * DAY : NaN;
  const days = Number.isFinite(monday)
    ? Array.from({ length: 7 }, (_, i) => ({ from: monday + i * DAY, isToday: false }))
    : [];
  const add = (item?: ImportItem) => {
    const id = `manual-${crypto.randomUUID()}`;
    setCourses((cs) => [
      ...cs,
      {
        id,
        course_id: id,
        name: item?.raw.split('\n')[0] || '新课程',
        teacher: '',
        location: '',
        weekday: 1,
        block: 1,
        start_period: 1,
        end_period: 2,
        weeks: [1],
        user_modified: true,
        source: item
          ? { sheet: item.sheet, row: item.row, column: item.column, raw: item.raw, item_id: item.id }
          : undefined,
      },
    ]);
    if (item)
      setItems((xs) =>
        xs.map((x) =>
          x.id === item.id ? { ...x, status: 'pending', course_ids: [...x.course_ids, id] } : x,
        ),
      );
  };
  const remove = (id: string) => {
    setCourses((cs) => cs.filter((c) => c.id !== id));
    setItems((xs) =>
      xs.map((x) =>
        x.course_ids.includes(id)
          ? {
              ...x,
              status: 'pending',
              message: `${x.message ?? ''}；人工移除规则 ${id}（${courses.find((c) => c.id === id)?.name ?? ''}）`,
              course_ids: x.course_ids.filter((i) => i !== id),
            }
          : x,
      ),
    );
  };
  async function save() {
    setSaving(true);
    setError('');
    try {
      await saveTimetable({
        ...table,
        courses,
        import_items: items,
        mode,
        expected_revision: saved?.revision ?? 0,
        confirm_loss: confirmLoss,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }
  const [exceptionDraft, setExceptionDraft] = useState({
    rule_id: '',
    kind: 'cancel' as CourseException['kind'],
    original_date: '',
    date: '',
    start_time: '',
    end_time: '',
    location: '',
    note: '',
  });
  return (
    <div className="mt-4 space-y-4 rounded-xl border bg-white p-4">
      <h2 className="font-semibold">课表核对与编辑</h2>
      <p className="text-sm" role="status">
        识别 {courses.length} 条课程规则；{items.length} 个源片段中 {pending} 个待确认、
        {items.filter((i) => i.status === 'ignored').length} 个明确忽略。预计保存 {diff.courses.length}{' '}
        条规则，按周展开后才是具体课次。
      </p>
      <p className="text-xs text-slate-500">
        原始内容保留在对账记录中。未知格式必须手动补全或写明忽略理由，不能带着待确认项覆盖课表。
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid text-sm">
          第一周周一
          <input
            type="date"
            className={input}
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              setConfirmed(false);
            }}
          />
        </label>
        {(['school', 'campus', 'term_name'] as const).map((k, i) => (
          <label key={k} className="grid text-sm">
            {['学校', '校区 / 作息方案（如冬季）', '学期名称'][i]}
            <input
              className={input}
              value={config[k]}
              onChange={(e) => setConfig({ ...config, [k]: e.target.value })}
            />
          </label>
        ))}
        <label className="grid text-sm">
          学期周数
          <input
            type="number"
            min="1"
            max="60"
            className={input}
            value={config.term_weeks}
            onChange={(e) => setConfig({ ...config, term_weeks: Number(e.target.value) })}
          />
        </label>
      </div>
      <details className="rounded border p-3">
        <summary className="cursor-pointer">学校 / 校区 / 本学期作息（{bells.length} 节，可修改）</summary>
        <p className="my-2 text-xs text-amber-800">
          默认时间只是示例，必须核对。不同校区、夏冬切换或特殊课时可在课程规则中覆盖实际时间；日期例外可用于单次调整。
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {bells.map((b, i) => (
            <div key={b.period} className="flex flex-wrap items-center gap-1 text-xs">
              <span>第 {b.period} 节</span>
              {(['start', 'end'] as const).map((k) => (
                <input
                  key={k}
                  aria-label={`第${b.period}节${k === 'start' ? '开始' : '结束'}`}
                  className={input}
                  type="time"
                  value={b[k]}
                  onChange={(e) => {
                    setBells((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)));
                    setConfirmed(false);
                  }}
                />
              ))}
            </div>
          ))}
        </div>
        <button
          className={`${button} mt-2`}
          disabled={bells.length >= 24}
          onClick={() => setBells([...bells, { period: bells.length + 1, start: '', end: '' }])}
        >
          增加节次（最多 24 节）
        </button>
      </details>
      <details>
        <summary className="cursor-pointer font-medium">导入原文与逐项对账（{items.length}）</summary>
        <div className="mt-2 space-y-2">
          {items.map((item) => (
            <SourceItem
              key={item.id}
              item={item}
              onManual={() => add(item)}
              onResolve={(ignore, reason) => {
                if (ignore) setCourses((cs) => cs.filter((c) => !item.course_ids.includes(c.id!)));
                setItems((xs) =>
                  xs.map((x) =>
                    x.id === item.id
                      ? {
                          ...x,
                          status: ignore ? 'ignored' : 'parsed',
                          message: x.message?.includes('人工移除规则')
                            ? `${x.message}；核对备注：${reason}`
                            : reason,
                          course_ids: ignore ? [] : x.course_ids,
                        }
                      : x,
                  ),
                );
              }}
            />
          ))}
        </div>
      </details>
      {!!parsed.warnings.length && (
        <details>
          <summary className="cursor-pointer text-amber-800">解析提示（{parsed.warnings.length}）</summary>
          <ul className="list-inside list-disc text-xs">
            {parsed.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <details open={editing}>
        <summary className="cursor-pointer font-medium">全部课程规则 / 修改字段（{courses.length}）</summary>
        <div className="mt-2 space-y-2">
          {courses.map((course) => (
            <CourseForm
              key={course.id}
              course={course}
              onChange={(next) => setCourses((cs) => cs.map((c) => (c.id === next.id ? next : c)))}
              onRemove={() => remove(course.id!)}
            />
          ))}
        </div>
      </details>
      <button className={button} onClick={() => add()}>
        手动添加课程
      </button>
      <details className="rounded border p-3">
        <summary className="cursor-pointer">
          停课 / 请假 / 补课 / 单次调课 / 暂时保留（{exceptions.length}）
        </summary>
        <p className="my-2 text-xs">
          学校调休必须按实际校历录入，不自动套用法定假日。请假和停课只取消该日期，不更改其他周。
        </p>
        {exceptions.map((e) => (
          <p key={e.id} className="my-2 break-words text-xs">
            {courses.find((c) => c.id === e.rule_id)?.name}：{e.original_date} · {e.kind} {e.date} {e.note}{' '}
            <button className={button} onClick={() => setExceptions((xs) => xs.filter((x) => x.id !== e.id))}>
              撤销此例外
            </button>
          </p>
        ))}
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="grid text-xs">
            课程
            <select
              className={input}
              value={exceptionDraft.rule_id}
              onChange={(e) => setExceptionDraft({ ...exceptionDraft, rule_id: e.target.value })}
            >
              <option value="">请选择</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · 周{c.weekday} · {periods(c).join('–')}节
                </option>
              ))}
            </select>
          </label>
          <label className="grid text-xs">
            处理
            <select
              className={input}
              value={exceptionDraft.kind}
              onChange={(e) =>
                setExceptionDraft({ ...exceptionDraft, kind: e.target.value as CourseException['kind'] })
              }
            >
              <option value="cancel">停课 / 请假</option>
              <option value="move">单次调课</option>
              <option value="add">补课</option>
              <option value="keep">暂时保留冲突</option>
            </select>
          </label>
          {(['original_date', 'date', 'start_time', 'end_time', 'location', 'note'] as const).map((k, i) => (
            <label key={k} className="grid text-xs">
              {
                [
                  '原课日期（补课填写关联日期）',
                  '新日期（调课 / 补课必填）',
                  '新开始（可空）',
                  '新结束（可空）',
                  '新地点（可空）',
                  '备注 / 请假原因',
                ][i]
              }
              <input
                className={input}
                type={i < 2 ? 'date' : i < 4 ? 'time' : 'text'}
                value={exceptionDraft[k]}
                onChange={(e) => setExceptionDraft({ ...exceptionDraft, [k]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <button
          className={`${button} mt-2`}
          disabled={!exceptionDraft.rule_id || !exceptionDraft.original_date}
          onClick={() => {
            setExceptions((xs) => [
              ...xs,
              { ...exceptionDraft, location: exceptionDraft.location || undefined, id: crypto.randomUUID() },
            ]);
          }}
        >
          添加例外（保存后生效）
        </button>
      </details>
      <div className="rounded bg-slate-50 p-3 text-sm">
        {!editing && (
          <label>
            重复导入方式{' '}
            <select
              className={input}
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as 'merge' | 'replace');
                setConfirmLoss(false);
              }}
            >
              <option value="merge">合并，保护人工修改</option>
              <option value="replace">整表替换（保留恢复版本）</option>
            </select>
          </label>
        )}
        <p className="my-2">
          新增 {diff.added} · 修改 {diff.changed} · 未变 {diff.unchanged} · 删除 {diff.removed} · 保留旧规则{' '}
          {diff.retained} · 保护人工修改 {diff.protectedEdits}
        </p>
        {termMismatch && (
          <p role="alert" className="text-red-700">
            新旧学期起点不同，不能直接合并。请核对校历后选择整表替换，避免将旧学期课程混入新学期。
          </p>
        )}
        <details>
          <summary className="cursor-pointer">查看逐条差异与最终字段</summary>
          <ul className="mt-2 space-y-1 text-xs">
            {diff.changes.map((change) => (
              <li key={change.before.id} className="rounded bg-amber-50 p-2 break-words">
                <p>{change.protected ? '保留人工修改，以下导入变更不应用' : '将修改'}：</p>
                <p>
                  原：{change.before.name} · {change.before.teacher} · {change.before.location} ·{' '}
                  {change.before.campus} · {change.before.class_name} · 周{change.before.weekday} ·{' '}
                  {periods(change.before).join('–')}节 · {ruleTimes(change.before, saved?.bells).join('–')} ·{' '}
                  {change.before.weeks.join(',')}周
                </p>
                <p>
                  新：{change.incoming.name} · {change.incoming.teacher} · {change.incoming.location} ·{' '}
                  {change.incoming.campus} · {change.incoming.class_name} · 周{change.incoming.weekday} ·{' '}
                  {periods(change.incoming).join('–')}节 · {ruleTimes(change.incoming, bells).join('–')} ·{' '}
                  {change.incoming.weeks.join(',')}周
                </p>
              </li>
            ))}
            {diff.courses.map((c) => (
              <li key={c.id}>
                {c.name} · {c.teacher || '未填教师'} · {c.location || '未填地点'} · 周{c.weekday} ·{' '}
                {periods(c).join('–')}节 · {ruleTimes(c, bells).join('–')} · {c.weeks.join(',')}周 ·{' '}
                {c.user_modified ? '人工修改' : ''}
              </li>
            ))}
            {mode === 'replace' &&
              saved?.courses
                .filter((c) => !diff.courses.some((n) => n.id === c.id))
                .map((c) => (
                  <li key={c.id} className="text-red-700">
                    将删除：{c.name} · 周{c.weekday} · {periods(c).join('–')}节
                  </li>
                ))}
          </ul>
        </details>
        {loss && (
          <label className="mt-2 flex items-start gap-2 text-red-800">
            <input type="checkbox" checked={confirmLoss} onChange={(e) => setConfirmLoss(e.target.checked)} />
            我已核对大量减少 / 人工修改被覆盖的差异，确认替换；可从最近 20 个版本恢复。
          </label>
        )}
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        我已核对第一周、学期长度、实际作息和全部课程原文。
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          className={`${button} bg-slate-900 text-white`}
          disabled={
            saving ||
            termMismatch ||
            pending > 0 ||
            !courses.length ||
            !confirmed ||
            (loss && !confirmLoss) ||
            !Number.isFinite(first) ||
            courses.some((c) => !c.weeks.length || !c.name.trim())
          }
          onClick={() => void save()}
        >
          {saving ? '保存中…' : '保存课表'}
        </button>
        <button className={button} disabled={saving} onClick={onCancel}>
          放弃
        </button>
      </div>
      <div className="border-t pt-3">
        <label className="text-sm">
          按周预览{' '}
          <input
            aria-label="预览周次"
            className={`${input} w-20`}
            type="number"
            min="1"
            max={config.term_weeks}
            value={previewWeek}
            onChange={(e) => setPreviewWeek(Number(e.target.value))}
          />
        </label>
        <p className="my-2 text-xs">
          {days.length ? `${dateString(monday)} 起；包含合并结果和日期例外。` : '先填写第一周周一以预览。'}
          单双周不同时发生，不会误报冲突。
        </p>
        {!!days.length && (
          <WeekGrid
            days={days}
            courses={diff.courses}
            timetable={table}
            itemsByDay={[]}
            onPick={() => {}}
            readonly
          />
        )}
      </div>
    </div>
  );
}

import { z } from 'zod';
import type { AssistantCapability, AssistantPolicy, AssistantResult } from '../../../../shared/assistant.js';

export interface AssistantApi {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  epoch: string;
}
interface Tool {
  label: string;
  policy: AssistantPolicy;
  description: string;
  schema: z.ZodType;
  run(args: Record<string, any>, api: AssistantApi): Promise<AssistantResult>;
}
const empty = z.object({}).strict();
const id = z.number().int().positive().safe();
const text = (max: number) => z.string().trim().min(1).max(max);
const groupId = text(200);
const eventChanges = z.object({
  status: z.enum(['active', 'cancelled', 'done', 'pending_confirm']).optional(),
  level: z.number().int().min(1).max(4).nullable().optional(), title: text(200).optional(),
  description: z.string().max(4000).optional(), location: z.string().max(300).nullable().optional(),
  action_required: z.string().max(1000).nullable().optional(),
  start_at: z.number().int().nonnegative().safe().nullable().optional(),
  end_at: z.number().int().nonnegative().safe().nullable().optional(),
  deadline_at: z.number().int().nonnegative().safe().nullable().optional(),
  unlock_fields: z.array(z.enum(['title', 'description', 'start_at', 'end_at', 'deadline_at', 'location', 'action_required'])).max(7).optional(),
}).strict().refine(v => Object.keys(v).length > 0, '需要修改字段');
const memory = z.object({ text: text(500), course: z.string().trim().max(100).default(''),
  event_types: z.array(z.enum(['exam', 'assignment', 'meeting', 'activity', 'announcement', 'other'])).max(6).default([]),
  action: z.enum(['exclude_calendar', 'note']).default('exclude_calendar'), enabled: z.boolean().optional(),
}).strict().refine(v => v.action !== 'exclude_calendar' || (!!v.course && v.event_types.length > 0), '排除规则需课程与事项类型');
const tools: Record<string, Tool> = {};
function apiTool(name: string, label: string, policy: AssistantPolicy, schema: z.ZodType,
  method: string, path: (args: any) => string, body: (args: any) => unknown = a => a,
  description = label) {
  tools[name] = { label, policy, description, schema, async run(args, api) {
    const data = await api.request(method, path(args), method === 'GET' ? undefined : body(args));
    return { tool: name, ok: true, message: data && typeof data === 'object' && 'accepted' in data && data.accepted === true ? `${label}已提交后台处理，请查看进度` : `${label}已完成`, data };
  } };
}
function step(name: string, label: string, href: string, description: string) {
  tools[name] = { label, policy: 'user_step', description, schema: empty, async run() {
    return { tool: name, ok: true, message: description, href, requiresUser: true };
  } };
}
apiTool('events.list', '查看日程', 'read', empty, 'GET', () => '/api/events');
apiTool('events.read', '查看事项详情及原始来源', 'read', z.object({ id }).strict(), 'GET', a => `/api/events/${a.id}`);
apiTool('todos.list', '查看待办', 'read', empty, 'GET', () => '/api/todos');
apiTool('groups.list', '查看群列表', 'read', empty, 'GET', () => '/api/groups');
apiTool('timetable.read', '查看课表', 'read', empty, 'GET', () => '/api/timetable');
apiTool('timetable.occurrences', '查询具体日期的课程及完成状态', 'read', z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  'GET', a => `/api/timetable/occurrences?from=${encodeURIComponent(a.from)}&to=${encodeURIComponent(a.to)}`, undefined,
  '最多查询70天和300课次，to日期不含；truncated为true时缩小日期范围重查。返回服务器确认的课次ID、日期、起止毫秒时间、done和课表revision；只使用真实返回的数据制定单次完成计划。');
apiTool('timetable.complete', '标记或撤销单次课程完成', 'confirm', z.object({ occurrence_id: text(500), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expected_start: z.number().int().safe(), expected_end: z.number().int().safe(), expected_revision: z.number().int().nonnegative(), done: z.boolean() }).strict(),
  'PUT', () => '/api/timetable/completions', undefined,
  '只标记具体日期的一次课或撤销该次完成，不改变未来重复规则。先从现场课次或timetable.occurrences取得精确标识/日期/时间/revision；日期不明确或同名多课次时先追问，禁止猜测或按整学期完成。');
apiTool('memory.list', '查看长期偏好', 'read', empty, 'GET', () => '/api/assistant/memories');
apiTool('trash.list', '查看回收站', 'read', empty, 'GET', () => '/api/trash');
apiTool('events.update', '修改事项或标记课程事项完成', 'confirm', z.object({ id, changes: eventChanges,
  expected_version: id, expected_updated_at: z.number().int().nonnegative().safe() }).strict(),
  'PATCH', a => `/api/events/${a.id}`, a => ({ ...a.changes, expected_version: a.expected_version, expected_updated_at: a.expected_updated_at }),
  '修改已存在事项。必须使用现场返回的精确 id/version/updated_at；课程事项标记 done，不把课表规则误当作已完成事件。');
apiTool('events.proposal', '接受或拒绝事项变更建议', 'confirm', z.object({ id, proposal_id: id,
  decision: z.enum(['accept', 'reject']), expected_version: id, expected_updated_at: z.number().int().nonnegative().safe() }).strict(),
  'POST', a => `/api/events/${a.id}/proposals/${a.proposal_id}/resolve`, a => ({ decision: a.decision, expected_version: a.expected_version, expected_updated_at: a.expected_updated_at }));
apiTool('todos.create', '创建待办', 'confirm', z.object({ title: text(100), note: z.string().max(500).default(''), level: z.number().int().min(1).max(4).default(2) }).strict(), 'POST', () => '/api/todos');
apiTool('todos.update', '修改或完成待办', 'confirm', z.object({ id, changes: z.object({ title: text(100).optional(), note: z.string().max(500).optional(), level: z.number().int().min(1).max(4).optional(), done: z.boolean().optional() }).strict().refine(v => Object.keys(v).length > 0) }).strict(), 'PATCH', a => `/api/todos/${a.id}`, a => a.changes);
apiTool('groups.update', '设置群启用状态和课程名', 'confirm', z.object({ id: groupId, enabled: z.boolean().optional(), course_name: z.string().trim().max(50).nullable().optional() }).strict().refine(v => v.enabled !== undefined || v.course_name !== undefined), 'PATCH', a => `/api/groups/${encodeURIComponent(a.id)}`, ({ id: _, ...a }) => a);
apiTool('groups.retry', '重新整理群通知（将调用用户 AI）', 'external', z.object({ id: groupId }).strict(), 'POST', a => `/api/groups/${encodeURIComponent(a.id)}/retry`, () => ({}));
apiTool('groups.clear', '清除群消息与事项', 'destructive', z.object({ id: groupId }).strict(), 'DELETE', a => `/api/groups/${encodeURIComponent(a.id)}/data`, () => ({}));
apiTool('memory.create', '保存当前空间长期偏好', 'confirm', memory, 'POST', () => '/api/assistant/memories');
apiTool('memory.update', '修改长期偏好', 'confirm', z.object({ id, rule: memory }).strict(), 'PATCH', a => `/api/assistant/memories/${a.id}`, a => a.rule);
apiTool('memory.delete', '删除长期偏好', 'destructive', z.object({ id }).strict(), 'DELETE', a => `/api/assistant/memories/${a.id}`, () => ({}));
apiTool('settings.memory', '设置自动总结重要性偏好', 'confirm', z.object({ enabled: z.boolean() }).strict(), 'PUT', () => '/api/settings/memory');
apiTool('settings.memory.read', '查看自动总结的重要性偏好', 'read', empty, 'GET', () => '/api/settings/memory');
apiTool('settings.memory.delete', '删除一条重要性偏好规则', 'destructive', z.object({ id }).strict(), 'DELETE', a => `/api/settings/memory/rules/${a.id}`, () => ({}));
apiTool('settings.memory.clear', '清空重要性偏好及调级历史', 'destructive', empty, 'DELETE', () => '/api/settings/memory');
apiTool('settings.reminders.read', '查看提醒设置', 'read', empty, 'GET', () => '/api/settings/reminders');
apiTool('settings.reminders', '设置提醒时间和次数', 'confirm', z.object({ enabled: z.literal(false), before_minutes: z.array(id).min(1).max(16), daily_limit: id, quiet_hours: z.literal('none'), missed_policy: z.literal('once_before_deadline') }).strict(), 'PUT', () => '/api/settings/reminders', a => a, '仅可保存提醒规则；手机渠道未验证前不能启用自动发送。');
apiTool('settings.lan', '更改局域网只读分享', 'external', z.object({ enabled: z.boolean() }).strict(), 'PUT', () => '/api/settings/lan');
apiTool('settings.lan.rotate', '作废旧手机分享链接并生成新链接', 'external', empty, 'POST', () => '/api/settings/lan/rotate');
apiTool('trash.restore', '恢复回收站事项', 'confirm', z.object({ id: text(200) }).strict(), 'POST', a => `/api/trash/${encodeURIComponent(a.id)}/restore`, () => ({}));
apiTool('timetable.versions', '查看课表恢复版本', 'read', empty, 'GET', () => '/api/timetable/versions');
apiTool('timetable.restore', '恢复课表版本', 'destructive', z.object({ id, expected_revision: z.number().int().nonnegative() }).strict(), 'POST', a => `/api/timetable/restore/${a.id}`, a => ({ expected_revision: a.expected_revision }));
apiTool('timetable.clear', '清空当前课表', 'destructive', z.object({ expected_revision: z.number().int().nonnegative() }).strict(), 'DELETE', () => '/api/timetable');
const course = z.object({ id: text(160).optional(), course_id: text(160).optional(), name: text(300), teacher: z.string().max(100).optional(), location: z.string().max(300).optional(), weekday: z.number().int().min(1).max(7), block: z.number().int().min(1).max(12), start_period: z.number().int().min(1).max(24).optional(), end_period: z.number().int().min(1).max(24).optional(), start_time: z.string().regex(/^\d{2}:\d{2}$/).optional(), end_time: z.string().regex(/^\d{2}:\d{2}$/).optional(), weeks: z.array(z.number().int().min(1).max(60)).min(1).max(60), campus: z.string().max(100).optional(), class_name: z.string().max(100).optional() }).strict();
tools['timetable.edit'] = { label: '编辑课程规则及学期设置', policy: 'confirm',
  description: '以当前revision核对，仅替换指定课程id或新增课程。保留其他课程和导入来源。删除课程请显式列在 remove_ids，后端再次检查冲突。',
  schema: z.object({ expected_revision: z.number().int().nonnegative(), courses: z.array(course).max(30).default([]), remove_ids: z.array(text(160)).max(30).default([]), semester_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), term_name: text(100).optional(), school: z.string().max(100).optional(), campus: z.string().max(100).optional(), term_weeks: z.number().int().min(1).max(60).optional(), bells: z.array(z.object({period:z.number().int().min(1).max(24),start:z.string().regex(/^\d{2}:\d{2}$/),end:z.string().regex(/^\d{2}:\d{2}$/)}).strict()).min(1).max(24).optional() }).strict(),
  async run(args, api) {
    const current = await api.request('GET', '/api/timetable') as any;
    if (current.revision !== args.expected_revision) throw new Error('课表已改变，请重新核对');
    const ids = new Set((current.courses as any[]).map(c => c.id));
    const requestedIds = args.courses.filter((c: any) => c.id).map((c: any) => c.id);
    if (new Set(requestedIds).size !== requestedIds.length || new Set(args.remove_ids).size !== args.remove_ids.length || requestedIds.some((id: string) => args.remove_ids.includes(id))) throw new Error('课程操作重复或冲突，请重新核对');
    if (args.remove_ids.some((id: string) => !ids.has(id)) || args.courses.some((c: any) => c.id && !ids.has(c.id))) throw new Error('课程 ID 不存在，请重新核对');
    const updates = new Map<string, any>(args.courses.filter((c: any) => c.id).map((c: any) => [c.id, c]));
    const courses = current.courses.filter((c: any) => !args.remove_ids.includes(c.id)).map((c: any) => updates.has(c.id) ? { ...c, ...updates.get(c.id), user_modified: true } : c).concat(args.courses.filter((c: any) => !c.id).map((c: any) => ({ teacher: '', location: '', ...c })));
    const data = await api.request('PUT', '/api/timetable', { ...current, ...Object.fromEntries(['semester_start','term_name','school','campus','term_weeks','bells'].filter(k => args[k] !== undefined).map(k => [k,args[k]])), courses, expected_revision: args.expected_revision, mode: 'replace', confirm_loss: true,
      import_items: current.import_items?.map((i: any) => ({ ...i, course_ids: i.course_ids.filter((id: string) => !args.remove_ids.includes(id)), ...(i.course_ids.some((id: string) => args.remove_ids.includes(id)) ? { status: 'ignored', message: '用户通过助手确认删除对应课程' } : {}) })) });
    return { tool: 'timetable.edit', ok: true, message: '课表已保存', data };
  } };
tools['timetable.exception'] = { label: '设置或撤销单次调课、停课', policy: 'confirm', description: '按课程规则 ID 和日期设置停课/调课/补课，保留其余课次；expected_revision防止覆盖并发编辑。',
  schema: z.object({ expected_revision: z.number().int().nonnegative(), exception: z.object({ id: text(160), rule_id: text(160), kind: z.enum(['cancel','move','add','keep']), original_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), start_time: z.string().regex(/^\d{2}:\d{2}$/).optional(), end_time: z.string().regex(/^\d{2}:\d{2}$/).optional(), location: z.string().max(300).optional(), note: z.string().max(500).optional() }).strict(), remove: z.boolean().default(false) }).strict(), async run(args, api) {
    const current = await api.request('GET', '/api/timetable') as any;
    if (current.revision !== args.expected_revision) throw new Error('课表已改变，请重新核对');
    if (!current.courses.some((c: any) => c.id === args.exception.rule_id)) throw new Error('课程不存在');
    const previous = current.exceptions ?? [];
    if (args.remove && !previous.some((e: any) => e.id === args.exception.id)) throw new Error('调课记录不存在');
    const exceptions = previous.filter((e: any) => e.id !== args.exception.id);
    if (!args.remove) exceptions.push(args.exception);
    const data = await api.request('PUT', '/api/timetable', { ...current, exceptions, expected_revision: args.expected_revision, mode: 'replace', confirm_loss: false });
    return { tool: 'timetable.exception', ok: true, message: '课次调整已保存', data };
  } };
tools['workspace.rename'] = { label: '修改当前空间名称', policy: 'confirm', description: '只更改当前空间名称，不切换身份。', schema: z.object({ name: text(256) }).strict(), async run(args, api) {
  const data = await api.request('PATCH', '/api/workspaces/name', { name: args.name, expected_account_epoch: api.epoch });
  return { tool: 'workspace.rename', ok: true, message: '空间名称已修改', data };
} };
// Operations requiring credentials, OS choices or file contents are explicit user steps.
step('settings.ai', '设置 AI 接口、模型和密钥', '/settings', '请在设置页 AI 接入卡填写接口、模型和密钥；助手不会读取或代填密钥。');
tools['settings.pet'] = { label: '设置桌宠显示、风格和恢复默认形象/位置', policy: 'confirm', description: '确认后只影响本浏览器（所有空间共用宠物外观），不影响其他设备；上传自定义形象需本人选文件。',
  schema: z.object({ visible: z.boolean().optional(), style: z.string().trim().max(120).optional(), reset_image: z.boolean().optional(), reset_position: z.boolean().optional() }).strict().refine(v => Object.keys(v).length > 0),
  async run(args) { return { tool: 'settings.pet', ok: true, message: '已确认桌宠设置，请以浏览器应用结果为准。', browserAction: { kind: 'pet_settings', patch: args } }; } };
tools['settings.pet.image'] = { label: '上传自定义桌宠形象', policy: 'user_step', description: '点击桌宠的形象设置按钮，自行选择本机图片；助手不能读取任意文件。', schema: empty, async run() {
  return { tool: 'settings.pet.image', ok: true, requiresUser: true, message: '请点击桌宠形象设置按钮，选择自己的图片并保存；尚未上传或更改形象。' };
} };
step('timetable.import', '导入课表文件或教务课表', '/settings', '请在设置页选择自己的课表文件，或自行输入教务登录信息；核对预览后保存。');
step('data.restore', '从备份恢复空间', '/settings', '请在设置页数据备份卡选择备份文件并确认覆盖；助手未执行恢复。');
step('data.reset', '清空当前空间', '/settings', '请在设置页数据管理卡确认清空范围；此操作会影响整个空间，助手未执行清空。');
step('connections.manage', '登录、退出或修复 QQ / 微信连接', '/connect', '请在连接页选择平台并登录、退出或修复连接；操作系统登录和权限需你本人完成。');
apiTool('history.status', '查看历史补全进度', 'read', empty, 'GET', () => '/api/history-jobs');
tools['history.sync'] = { label: '补全 QQ / 微信历史记录', policy: 'external', description: '仅对已授权的读取范围创建或复用长任务；可能将通知交给用户配置的 AI 整理。没有有效连接或读取范围时需用户先去连接页选择。',
  schema: z.object({ platform: z.enum(['qq', 'wechat']), days: z.union([z.literal(1), z.literal(7), z.literal(30)]) }).strict(), async run(args, api) {
    const data = await api.request('POST', '/api/history-jobs', { ...args, expected_account_epoch: api.epoch, approve_history_read: true });
    return { tool: 'history.sync', ok: true, message: '历史任务已提交或复用已有任务；请在连接页查看持续进度，这不表示历史已全部补齐。', href: '/connect', data };
  } };
for (const operation of ['cancel', 'retry'] as const) tools[`history.${operation}`] = {
  label: operation === 'cancel' ? '取消历史补全' : '继续重试历史补全', policy: operation === 'cancel' ? 'confirm' : 'external',
  description: operation === 'cancel' ? '当前页入库完成后安全停止，不删除已读数据。' : '同一任务续传并去重，不重复启动独立任务。',
  schema: z.object({ id: z.string().uuid() }).strict(), async run(args, api) {
    const data = await api.request('POST', `/api/history-jobs/${args.id}/${operation}`, { expected_account_epoch: api.epoch });
    return { tool: `history.${operation}`, ok: true, message: operation === 'cancel' ? '已请求安全停止；请查看任务最终状态。' : '已请求继续任务；请查看持续进度。', href: '/connect', data };
  } };
step('wechat.selection', '选择微信群和读取范围', '/groups?platform=wechat', '请在微信群页面刷新目录并勾选需要读取的微信群；读取权限需要你明确选择。');
step('demo.manage', '演示及文本导入', '/demo', '请在演示页选择脱敏样本或输入要导入的文本，核对 AI 外发内容后运行。');
step('workspace.manage', '管理空间名称、身份绑定和旧账号数据', '/settings', '请在设置页管理空间或旧账号；切换身份需在连接页由本人确认。');
step('data.backup', '下载当前空间备份', '/api/settings/data/backup', '点击下载当前空间数据库备份；文件由浏览器保存，助手不读取文件内容。');
step('events.export', '导出日程 ICS', '/api/export.ics', '点击下载日历文件；是否导入或分享给其他服务由你决定。');

export function capabilities(): AssistantCapability[] {
  return Object.entries(tools).map(([name, t]) => ({ name, label: t.label, policy: t.policy, description: t.description,
    parameters: z.toJSONSchema(t.schema, { unrepresentable: 'any' }) as Record<string, unknown> }));
}
export function parseAction(value: unknown) {
  const parsed = z.object({ tool: text(80), args: z.record(z.string(), z.unknown()) }).strict().parse(value);
  const tool = Object.hasOwn(tools, parsed.tool) ? tools[parsed.tool]! : undefined;
  if (!tool) throw new Error('助手提出了未开放的操作，未执行任何更改');
  const args = tool.schema.parse(parsed.args) as Record<string, unknown>;
  const policy: AssistantPolicy = parsed.tool === 'timetable.edit' && Array.isArray(args.remove_ids) && args.remove_ids.length ? 'destructive' : tool.policy;
  return { tool: parsed.tool, args, label: tool.label, policy };
}
export async function executeAction(action: ReturnType<typeof parseAction>, api: AssistantApi): Promise<AssistantResult> {
  // Revalidate immutable saved arguments at execution as defense in depth.
  const checked = parseAction({ tool: action.tool, args: action.args });
  return tools[checked.tool]!.run(checked.args, api);
}

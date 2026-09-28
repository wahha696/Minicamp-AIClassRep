import { afterEach, describe, expect, it, vi } from 'vitest';
import { csuBeginImport, csuFetchCourses } from './csujwc.js';
import { notifyAccountSwitch } from './db/index.js';

const login = 'https://ca.csu.edu.cn/authserver/login?service=http%3A%2F%2Fcsujwc.its.csu.edu.cn%2Fsso.jsp';
const page = '<form action="/authserver/login"><input id="execution" value="e1s1"><input id="pwdEncryptSalt" value="1234567890123456"></form>';
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html;charset=utf-8' } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
function mockLogin(need: Response = Response.json({ isNeed: false })) {
  const mock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(redirect(login))
    .mockResolvedValueOnce(html(page))
    .mockResolvedValueOnce(need);
  vi.stubGlobal('fetch', mock);
  return mock;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('CAS 登录请求与错误归因', () => {
  it('保留 service,提交空验证码,不混入指纹字段;CAS 500 不重试', async () => {
    const mock = mockLogin().mockResolvedValueOnce(html('server error', 500));
    const s = await csuBeginImport('000000', 'test-password');
    await expect(csuFetchCourses(s.session_id, '')).rejects.toThrow('统一身份认证接口返回服务器错误');
    expect(mock).toHaveBeenCalledTimes(4);
    const [url, init] = mock.mock.calls[3]!;
    expect(url).toBe(login);
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('captcha')).toBe('');
    expect(body.has('responseJson')).toBe(false);
    expect(body.get('password')).not.toBe('test-password');
    await expect(csuFetchCourses(s.session_id, '')).rejects.toThrow('登录会话不存在');
  });

  it.each([Response.json({ error: 'unavailable' }), html('unavailable', 503)])('验证码检查异常不提交登录', async (response) => {
    const mock = mockLogin(response);
    await expect(csuBeginImport('000000', 'test-password')).rejects.toThrow('无法确认');
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('需要验证码时返回图片并提交用户输入', async () => {
    const mock = mockLogin(Response.json({ isNeed: true }))
      .mockResolvedValueOnce(new Response('image', { headers: { 'content-type': 'image/png' } }))
      .mockResolvedValueOnce(html(page));
    const s = await csuBeginImport('000000', 'test-password');
    expect(s.captcha).toMatch(/^data:image\/png;base64,/);
    await expect(csuFetchCourses(s.session_id, 'AB12')).rejects.toThrow('统一身份认证登录失败');
    expect(new URLSearchParams(String(mock.mock.calls[4]![1]?.body)).get('captcha')).toBe('AB12');
  });

  it('教务回跳 HTML 500 重试一次后可继续解析课表', async () => {
    const mock = mockLogin()
      .mockResolvedValueOnce(redirect('http://csujwc.its.csu.edu.cn/sso.jsp?ticket=fake'))
      .mockResolvedValueOnce(html('<html>server error</html>', 500))
      .mockResolvedValueOnce(html('<a href="/jsxsd/xskb/xskb_list.do">课表</a>'))
      .mockResolvedValueOnce(html('<table id="kbtable"><tr><td>节次/星期</td><td>星期一</td></tr><tr><td>第1-2节</td><td>课程甲<br>1-16周<br>教师甲<br>A101</td></tr></table>'));
    const s = await csuBeginImport('000000', 'test-password');
    await expect(csuFetchCourses(s.session_id, '')).resolves.toHaveProperty('courses');
    expect(mock.mock.calls[5]![0]).toBe('http://csujwc.its.csu.edu.cn/sso.jsp');
    expect(mock).toHaveBeenCalledTimes(7);
  });

  it('过期会话不发出登录请求', async () => {
    const mock = mockLogin();
    const s = await csuBeginImport('000000', 'test-password');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
    await expect(csuFetchCourses(s.session_id, '')).rejects.toThrow('登录会话已超时');
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('换账号会立即销毁待用教务会话，旧 session_id 不能在新账号复用', async () => {
    const mock = mockLogin();
    const s = await csuBeginImport('000000', 'test-password');
    notifyAccountSwitch('22222');

    await expect(csuFetchCourses(s.session_id, '')).rejects.toThrow('登录会话不存在或已超时');
    expect(mock).toHaveBeenCalledTimes(3); // 绝不向 CAS 提交旧账号凭据
  });

  it('挂起会话到 TTL 会主动销毁，不需要再次 start 才清理', async () => {
    vi.useFakeTimers();
    const mock = mockLogin();
    const s = await csuBeginImport('000000', 'test-password');
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);

    await expect(csuFetchCourses(s.session_id, '')).rejects.toThrow('登录会话不存在或已超时');
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('在线导入解析横排节次页面,忽略校历', async () => {
    mockLogin()
      .mockResolvedValueOnce(redirect('http://csujwc.its.csu.edu.cn/sso.jsp?ticket=fake'))
      .mockResolvedValueOnce(html('<a href="/jsxsd/xskb/xskb_list.do">课表</a>'))
      .mockResolvedValueOnce(html('<table id="kbtable"><tr><td></td><td>1－2</td><td>3－4</td></tr><tr><td>星期四</td><td></td><td>课程甲<br>1-16周(32学时)<br>A101<br>某班</td></tr><tr><td>校历</td><td>2026-9</td><td>第1周</td></tr></table>'));
    const s = await csuBeginImport('000000', 'test-password');
    const result = await csuFetchCourses(s.session_id, '');
    expect(result.courses).toMatchObject([{ name: '课程甲', weekday: 4, start_period: 3, end_period: 4 }]);
    expect(result.warnings).toEqual([]);
  });

  it('零课程页面不作为成功导入返回', async () => {
    mockLogin()
      .mockResolvedValueOnce(redirect('http://csujwc.its.csu.edu.cn/sso.jsp?ticket=fake'))
      .mockResolvedValueOnce(html('<a href="/jsxsd/xskb/xskb_list.do">课表</a>'))
      .mockResolvedValueOnce(html('<table id="kbtable"><tr><td>2026-9</td><td>第1周</td></tr></table>'));
    const s = await csuBeginImport('000000', 'test-password');
    await expect(csuFetchCourses(s.session_id, '')).rejects.toThrow('未识别到有效课程');
  });
});

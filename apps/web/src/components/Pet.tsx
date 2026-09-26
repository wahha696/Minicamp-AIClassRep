// 网页桌宠：「AI课代表」的看板娘，常驻页面右下角（仅桌面端）。
// 设计决策（编号方便讨论/回滚）：
// - PET-1 素材：src/assets/nailong.jpg（奶龙图，约 1:1 的 JPG，圆角卡片 + 投影展示）；
//   换素材直接替换 assets 里的图片文件即可，行为逻辑不动。
// - PET-2 只在 md+ 显示：手机屏幕小、底部已有 Tab 栏，桌宠会挡内容。
// - PET-3 交互：单击→跳一下并说一句；双击→打开对话框；按住拖动→全页面自由移动（上下左右都行）；
//   右键→菜单（问话/走两步/跳页面/收起）。收起后右下角留半透明小按钮召回；
//   位置与开关记 localStorage（classrep.pet.*），刷新后保持。
// - PET-4 台词数据：60s 低频轮询 getToday（只读、失败静默降级为闲聊），不写任何接口。
// - PET-5 层级 z-30：盖过普通内容，低于详情抽屉(z-40)与弹窗/Toast(z-50)，不挡正事。
// - PET-6 性能与体贴：位移动画只用 transform；系统开「减少动态效果」时自动停掉
//   呼吸/摇摆/Zzz 等循环动画（见 pet.css）。
// - PET-7 双击对话框：规则引擎在 lib/petChat.ts（纯函数、离线可用），可查日程/截止/群，
//   也能执行同步、跳页面、走两步；连接状态复用 ConnectStatusProvider，零额外轮询。
// - PET-8 系统联动：新事件播报（轮询 diff）→ 临期提醒（10/5/1 分钟各一次）→
//   连接状态变化感知（中断/被踢/恢复）。对话框开着时，这些播报改走对话框，不打架。
// - PET-9 深夜（23:00~6:00）自动睡觉：Zzz 浮标，不闲聊不散步，点了会嘟囔一句。
// - PET-10 全页自由移动：不再只左右走，x/y 都可动、可拖到页面任意位置；
//   气泡/菜单/对话框贴屏幕上沿时自动改到桌宠下方弹出。
// - PET-11 高频自主活动：6~12s 一次概率触发散步或跳一下（原来 16~38s），睡觉/收起时不闹腾。
// - PET-12 对话接入 DeepSeek：规则引擎（lib/petChat.ts）优先——命中即答还能执行动作；
//   没命中才走 /api/pet/chat 由后端持 key 调 DeepSeek；LLM 失败回退规则兜底，用户无感。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { getGroups, getToday, syncNow } from '../api/client';
import type { ConnectState } from '../api/types';
import { useConnectStatus } from './ConnectStatus';
import { usePolling } from '../hooks/usePolling';
import { clamp, petGreeting, petLine } from '../lib/pet';
import { groupListText, petReply, QUICK_QUESTIONS } from '../lib/petChat';
import type { ChatAction } from '../lib/petChat';
import { askPetLlm, llmAvailable } from '../lib/petLlm';
import nailongUrl from '../assets/nailong.jpg';
import './pet.css';

const SIZE = 92; // 本体宽度(px)，素材约 1:1，高约 90px
const EDGE = 12; // 左右贴边留白(px)

const STORE_X = 'classrep.pet.x';
const STORE_Y = 'classrep.pet.y';
const STORE_HIDDEN = 'classrep.pet.hidden';

type Phase = 'idle' | 'walk' | 'drag';

/** 对话框里的一条消息 */
interface ChatMsg {
  id: number;
  role: 'bot' | 'user';
  text: string;
}

function readStore(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStore(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 隐私模式等场景，静默忽略 */ }
}

/** 活动范围：左右各留 EDGE，再让出本体宽度 */
function xRange(): [number, number] {
  return [EDGE, Math.max(EDGE, window.innerWidth - SIZE - EDGE)];
}
const PET_H = 96; // 本体高约 90px（素材约 1:1）+ 影子/贴边余量
/** 垂直活动范围：0 = 蹲在页面底边，hi = 顶到页面上沿还留一点空隙 */
function yRange(): [number, number] {
  return [0, Math.max(0, window.innerHeight - PET_H - 8)];
}

export default function Pet() {
  // ===== 位置与姿态 =====
  const [x, setX] = useState<number>(() => {
    const hi = Math.max(EDGE, (typeof window === 'undefined' ? 1280 : window.innerWidth) - SIZE - EDGE);
    const saved = Number(readStore(STORE_X));
    return Number.isFinite(saved) && saved >= EDGE ? clamp(saved, EDGE, hi) : hi; // 默认蹲右下角
  });
  const [y, setY] = useState<number>(() => {
    const hi = Math.max(0, (typeof window === 'undefined' ? 800 : window.innerHeight) - PET_H - 8);
    const saved = Number(readStore(STORE_Y));
    return Number.isFinite(saved) && saved > 0 ? clamp(saved, 0, hi) : 0; // 默认贴地
  });
  const [phase, setPhase] = useState<Phase>('idle');
  const [facing, setFacing] = useState<1 | -1>(-1); // 默认面朝左（看着页面中间）
  const [walkDur, setWalkDur] = useState(1);
  const [anim, setAnim] = useState<'none' | 'hop' | 'land'>('none');
  const [speech, setSpeech] = useState<{ text: string; id: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hidden, setHidden] = useState(() => readStore(STORE_HIDDEN) === '1');
  const [chatOpen, setChatOpen] = useState(false);          // PET-7 双击对话框
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);          // 对话记录（收起桌宠也保留）
  const [nowTick, setNowTick] = useState(() => Date.now()); // 30s 心跳：驱动临期提醒与睡眠判断

  const { data } = usePolling(getToday, 60_000);            // PET-4：只读低频轮询，失败静默
  const { data: conn } = useConnectStatus();                // PET-7：复用全局连接状态，零额外请求
  const nav = useNavigate();

  // 回调里要读「最新值」，用渲染期同步的 ref（与 usePolling 的 fnRef 同一写法）
  const xRef = useRef(x); xRef.current = x;
  const yRef = useRef(y); yRef.current = y;
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const menuRef = useRef(menuOpen); menuRef.current = menuOpen;
  const chatOpenRef = useRef(chatOpen); chatOpenRef.current = chatOpen;
  const msgsRef = useRef(msgs); msgsRef.current = msgs;
  const todayRef = useRef(data); todayRef.current = data;
  const connRef = useRef(conn); connRef.current = conn;
  const drag = useRef<{ id: number; px: number; py: number; bx: number; by: number; moved: boolean } | null>(null);
  const speechTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animSeq = useRef(0);
  const greetedRef = useRef(false);
  const lastClickRef = useRef(0);            // 双击判定
  const msgSeq = useRef(0);                  // 对话消息 id
  const remindedRef = useRef(new Map<number, number>()); // 每件事提醒到哪一级了（10/5/1 分钟）
  const knownIdsRef = useRef<Set<number> | null>(null);  // 新事件播报：上次见到的事件 id
  const mountedAtRef = useRef(Date.now());
  const prevConnRef = useRef<ConnectState | undefined>(undefined);

  const hour = new Date(nowTick).getHours();
  const sleeping = hour >= 23 || hour < 6; // PET-9
  const sleepingRef = useRef(sleeping); sleepingRef.current = sleeping;

  // ===== 台词 =====
  const speak = useCallback((text: string, ms = 5200) => {
    setSpeech({ text, id: Date.now() });
    if (speechTimer.current) clearTimeout(speechTimer.current);
    speechTimer.current = setTimeout(() => setSpeech(null), ms);
  }, []);
  function saySomething() {
    const t = todayRef.current;
    notify(petLine(t?.events ?? [], Date.now(), t?.summary));
  }

  /** 统一出口：对话框开着就进对话框，否则冒气泡（PET-8） */
  function notify(text: string, ms = 5200) {
    if (chatOpenRef.current) pushMsg('bot', text);
    else speak(text, ms);
  }

  // ===== 对话（PET-7） =====
  function pushMsg(role: ChatMsg['role'], text: string): number {
    const id = ++msgSeq.current;
    setMsgs((ms) => [...ms, { id, role, text }]); // updater 保持纯净，StrictMode 下也安全
    return id;
  }
  /** 把占位的「…」替换成真正的回答 */
  function replaceMsg(id: number, text: string) {
    setMsgs((ms) => ms.map((m) => (m.id === id ? { ...m, text } : m)));
  }
  function openChat() {
    if (speechTimer.current) clearTimeout(speechTimer.current);
    setSpeech(null);
    setMenuOpen(false);
    setChatOpen(true);
    if (msgsRef.current.length === 0) {
      const t = todayRef.current;
      pushMsg('bot', `${petGreeting(new Date().getHours())}！我是课代表小助手${t ? `，${t.summary}` : ''}。点下面的问题，或直接打字问我~`);
    }
  }
  function send(raw: string) {
    const text = raw.trim();
    if (text.length === 0) return;
    pushMsg('user', text);
    const t = todayRef.current;
    const ctx = {
      now: Date.now(),
      summary: t?.summary,
      events: t?.events ?? [],
      connect: connRef.current?.state,
    };
    const answer = petReply(text, ctx);
    if (answer.matched || !llmAvailable()) {
      // 规则命中（或 mock 模式）：直接回答，还能执行动作
      pushMsg('bot', answer.text);
    } else {
      // PET-12：规则没命中 → 走后端 DeepSeek；失败/超时回退规则兜底话术
      const id = pushMsg('bot', '…');
      void askPetLlm(text, msgsRef.current, ctx)
        .then((reply) => replaceMsg(id, reply))
        .catch(() => replaceMsg(id, answer.text));
    }
    if (answer.needGroups) {
      void getGroups()
        .then((gs) => pushMsg('bot', groupListText(gs)))
        .catch(() => pushMsg('bot', '群列表没取到，去「群管理」页看看吧。'));
    }
    if (answer.action) runAction(answer.action);
  }
  function runAction(a: ChatAction) {
    if (a === 'sync') { void doSync(); return; }
    if (a === 'stroll') { stroll(); playAnim('hop', 640); return; }
    nav(a === 'nav-week' ? '/week' : a === 'nav-groups' ? '/groups' : '/');
  }
  async function doSync() {
    try {
      const r = await syncNow();
      pushMsg('bot', `同步完成：${r.groups} 个群、${r.messages} 条消息。`);
    } catch {
      pushMsg('bot', '同步失败了，可能 QQ 没连上，去「连接」页看看吧。');
    }
  }
  const sayRefStable = useRef(saySomething); sayRefStable.current = saySomething;

  // ===== 姿态小工具 =====
  function playAnim(kind: 'hop' | 'land', ms: number) {
    const s = ++animSeq.current;
    setAnim(kind);
    window.setTimeout(() => { if (animSeq.current === s) setAnim('none'); }, ms);
  }
  const walkTo = useCallback((targetX: number, targetY?: number) => {
    if (phaseRef.current !== 'idle') return;
    const [xlo, xhi] = xRange();
    const [ylo, yhi] = yRange();
    const tx = clamp(targetX, xlo, xhi);
    const ty = clamp(targetY ?? yRef.current, ylo, yhi);
    const dx = tx - xRef.current;
    const dy = ty - yRef.current;
    if (Math.hypot(dx, dy) < 12) return;
    const dur = clamp(Math.hypot(dx, dy) / 110, 0.6, 2.4); // 约 130px/s 的匀速小碎步
    if (Math.abs(dx) > 6) setFacing(dx > 0 ? 1 : -1);
    setWalkDur(dur);
    setPhase('walk');
    setX(tx);
    setY(ty);
    window.setTimeout(() => {
      if (phaseRef.current === 'walk') {
        setPhase('idle');
        writeStore(STORE_X, String(Math.round(tx)));
        writeStore(STORE_Y, String(Math.round(ty)));
      }
    }, dur * 1000 + 100);
  }, [setX, setY]);
  function stroll() {
    // PET-10：全页面随机挑一个点，尽量离当前位置远一点，走起来才像散步
    const [xlo, xhi] = xRange();
    const [ylo, yhi] = yRange();
    let tx = xRef.current;
    let ty = yRef.current;
    for (let i = 0; i < 5; i++) {
      tx = xlo + Math.random() * (xhi - xlo);
      ty = ylo + Math.random() * (yhi - ylo);
      if (Math.hypot(tx - xRef.current, ty - yRef.current) > 120) break;
    }
    walkTo(tx, ty);
  }
  function hide() {
    setHidden(true);
    writeStore(STORE_HIDDEN, '1');
  }

  // 首次拿到今日数据 → 打招呼顺带报一句日程
  useEffect(() => {
    if (!data || greetedRef.current) return;
    greetedRef.current = true;
    speak(`${petGreeting(new Date().getHours())}！${data.summary}`, 6500);
  }, [data, speak]);

  // 30s 心跳（临期提醒的节拍，也顺带让「睡觉」状态随时间翻转）
  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // PET-8a 新事件播报：对比两次轮询的事件 id，出现新的 active 事件就说一句
  useEffect(() => {
    if (!data) return;
    const prev = knownIdsRef.current;
    knownIdsRef.current = new Set(data.events.map((e) => e.id));
    if (!prev) return; // 首次只建索引，不播报
    if (Date.now() - mountedAtRef.current < 15_000) return; // 刚打开页面的批量加载不算「新」
    const fresh = data.events.filter((e) => !prev.has(e.id) && (e.status === 'active' || e.status === 'pending_confirm'));
    if (fresh.length > 0) notify(`群里新安排：「${fresh[0].title}」，今日页已经更新啦！`, 8000);
  }, [data]);

  // PET-8b 临期提醒：开始前 10 / 5 / 1 分钟各提醒一次
  useEffect(() => {
    if (document.hidden) return;
    const events = todayRef.current?.events;
    if (!events) return;
    for (const e of events) {
      if (e.status !== 'active' || e.start_at === null) continue;
      const min = (e.start_at - nowTick) / 60_000;
      if (min > 10.5 || min < -0.5) continue;
      const level: 10 | 5 | 1 = min <= 1.5 ? 1 : min <= 5.5 ? 5 : 10;
      const prev = remindedRef.current.get(e.id);
      if (prev !== undefined && prev <= level) continue;
      remindedRef.current.set(e.id, level);
      notify(level === 1 ? `马上要「${e.title}」了，快准备！` : `「${e.title}」${level} 分钟后开始，别走开~`, 8000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowTick]);

  // PET-8c 连接状态感知：状态变化才说话（黄条负责常驻提示，桌宠只补一句「人话」）
  useEffect(() => {
    const s = conn?.state;
    if (!s) return;
    const prev = prevConnRef.current;
    prevConnRef.current = s;
    if (!prev || prev === s) return;
    if (s === 'reconnecting') notify('连接中断了，我在盯着重连，页面照常能用~', 8000);
    else if (s === 'kicked') notify('QQ 在另一台电脑登录了，采集暂停。去「连接」页点「重新连接」吧。', 8000);
    else if (s === 'error') notify('采集端出问题了，去「连接」页看看吧。', 8000);
    else if (s === 'waiting_qr') notify('需要扫码登录（仅首次），扫完我马上开工~', 8000);
    else if (s === 'online' && prev !== 'online') notify('连上啦！群通知继续盯~', 5000);
  }, [conn?.state]);

  // 闲聊：45~105s 随机说一句；切后台/聊天中/睡觉时跳过
  useEffect(() => {
    if (hidden) return;
    let alive = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const loop = () => {
      t = setTimeout(() => {
        if (!alive) return;
        if (!document.hidden && phaseRef.current === 'idle' && !chatOpenRef.current && !sleepingRef.current && Math.random() < 0.55) sayRefStable.current();
        loop();
      }, 45_000 + Math.random() * 60_000);
    };
    loop();
    return () => { alive = false; if (t) clearTimeout(t); };
  }, [hidden]);

  // 随机活动：PET-11，6~12s 一次概率触发——散步（全页随机点）为主，偶尔原地跳一下
  useEffect(() => {
    if (hidden) return;
    let alive = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const loop = () => {
      t = setTimeout(() => {
        if (!alive) return;
        if (!document.hidden && phaseRef.current === 'idle' && !menuRef.current && !sleepingRef.current) {
          const roll = Math.random();
          if (roll < 0.6) stroll();
          else if (roll < 0.72) playAnim('hop', 640);
        }
        loop();
      }, 6_000 + Math.random() * 6_000);
    };
    loop();
    return () => { alive = false; if (t) clearTimeout(t); };
  }, [hidden]);

  // 窗口变小（宽或高）时别把自己挤出屏幕
  useEffect(() => {
    const onResize = () => {
      const [xlo, xhi] = xRange();
      const [ylo, yhi] = yRange();
      setX(clamp(xRef.current, xlo, xhi));
      setY(clamp(yRef.current, ylo, yhi));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setX, setY]);

  // 右键菜单点外面就关
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  // ===== 拖拽/单击/双击（PET-3）=====
  function onBodyPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return; // 右键交给 contextmenu
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 已释放，忽略 */ }
    drag.current = { id: e.pointerId, px: e.clientX, py: e.clientY, bx: x, by: y, moved: false };
    setPhase('drag');
    setMenuOpen(false);
    animSeq.current++; // 作废进行中的动画
  }
  function onBodyPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved) { if (Math.hypot(dx, dy) < 6) return; d.moved = true; }
    const [xlo, xhi] = xRange();
    const [ylo, yhi] = yRange();
    setX(clamp(d.bx + dx, xlo, xhi));
    setY(clamp(d.by - dy, ylo, yhi)); // 往上拖 dy 为负 → y 增大
  }
  function endDrag(e: ReactPointerEvent<HTMLDivElement>, clicked: boolean) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (phaseRef.current !== 'drag') return;
    if (!d.moved && clicked) {
      setPhase('idle');
      playAnim('hop', 640);
      const now = Date.now();
      const isDouble = now - lastClickRef.current < 350; // PET-7：双击开/关对话框
      lastClickRef.current = now;
      if (isDouble) {
        if (chatOpenRef.current) setChatOpen(false);
        else openChat();
        return;
      }
      if (chatOpenRef.current) return; // 聊天开着时单击只跳一下，不冒气泡
      if (sleepingRef.current) { speak('呼啊…这么晚还不睡呀？'); return; }
      sayRefStable.current();
      return;
    }
    // 松手落地：压扁回弹一下，位置记住（PET-10 全页坐标）
    setPhase('idle');
    writeStore(STORE_X, String(Math.round(xRef.current)));
    writeStore(STORE_Y, String(Math.round(yRef.current)));
    playAnim('land', 470);
  }

  // ===== 收起状态：右下角一个半透明小按钮召回 =====
  if (hidden) {
    return (
      <button
        type="button"
        title="召唤课代表"
        onClick={() => { setHidden(false); writeStore(STORE_HIDDEN, '0'); speak('我回来啦！', 4000); }}
        className="pointer-events-auto fixed bottom-4 right-4 z-30 hidden h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white/70 text-slate-400 shadow-sm backdrop-blur transition hover:bg-white hover:text-slate-700 md:flex"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <circle cx="8.6" cy="11" r="2.5" />
          <circle cx="15.4" cy="11" r="2.5" />
          <path d="M11.1 11h1.8" />
          <path d="M10 15.4q2 1.5 4 0" />
        </svg>
      </button>
    );
  }

  // 气泡/菜单/对话框贴边时别伸出屏幕外（PET-10：含上下——桌宠靠上时改到本体下方弹出）
  const align = x < 150 ? 'left-0' : x > window.innerWidth - 210 ? 'right-0' : 'left-1/2 -translate-x-1/2';
  const chatAlign = x < 165 ? 'left-0' : x > window.innerWidth - 345 ? 'right-0' : 'left-1/2 -translate-x-1/2';
  const nearTop = y > Math.max(0, window.innerHeight - 340); // 顶部留白不够放面板时，改从下方弹出
  const upPos = 'bottom-full mb-3';
  const downPos = 'top-full mt-3';

  return (
    <div
      className="fixed bottom-0 left-0 z-30 hidden md:block"
      style={{
        width: SIZE,
        transform: `translate3d(${x}px, ${-y}px, 0)`,
        transition: phase === 'walk' ? `transform ${walkDur}s ease-in-out` : 'none',
      }}
    >
      {/* 脚下影子：跟着本体走（全页坐标后影子和本体一起动） */}
      <div
        className="absolute bottom-[2px] left-1/2 h-2.5 rounded-[50%] bg-slate-900/15"
        style={{ width: SIZE * 0.62, transform: 'translateX(-50%)' }}
      />

      {/* 本体：位移全走 transform（PET-6）；全页坐标见 PET-10 */}
      <div
        className={`pointer-events-auto absolute bottom-1 left-0 flex touch-none select-none items-end ${
          phase === 'drag' ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        onPointerDown={onBodyPointerDown}
        onPointerMove={onBodyPointerMove}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
        onContextMenu={(e) => { e.preventDefault(); setMenuOpen((v) => !v); }}
      >
        {/* 翻面：素材整体左右镜像（面朝走路方向） */}
        <div
          className={facing === -1 ? 'pet-flipped' : undefined}
          style={{ transform: `scaleX(${facing})`, transition: 'transform 0.25s ease' }}
        >
          <div className={phase === 'walk' ? 'pet-waddle' : anim === 'hop' ? 'pet-hop' : anim === 'land' ? 'pet-land' : undefined}>
            <PetSprite sleeping={sleeping} />
          </div>
        </div>

        {/* 台词气泡（对话框开着时统一走对话框，见 PET-8；贴屏幕上沿时改到下方弹出） */}
        {speech && (
          <div className={`absolute ${nearTop ? downPos : upPos} ${align}`} aria-live="polite">
            <div
              key={speech.id}
              className="pet-pop pointer-events-none relative w-max max-w-56 rounded-2xl border border-slate-200 bg-white px-3.5 py-2 text-sm leading-relaxed text-slate-700 shadow-lg"
            >
              {speech.text}
              <span className={`absolute left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-b border-r border-slate-200 bg-white ${nearTop ? '-top-[7px] border-t border-b-0 border-r-0' : '-bottom-[7px]'}`} />
            </div>
          </div>
        )}

        {/* 右键菜单 */}
        {menuOpen && (
          <div className={`absolute ${nearTop ? 'top-full mt-9' : 'bottom-full mb-9'} ${align}`} onPointerDown={(e) => e.stopPropagation()}>
            <div className="pet-pop overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl">
              {[
                { label: '找我问话', act: () => { setMenuOpen(false); openChat(); } },
                { label: '说句话', act: () => { setMenuOpen(false); sayRefStable.current(); } },
                { label: '走两步', act: () => { setMenuOpen(false); stroll(); } },
                { divider: true },
                { label: '去今日', act: () => { setMenuOpen(false); nav('/'); } },
                { label: '去本周', act: () => { setMenuOpen(false); nav('/week'); } },
                { label: '去群管理', act: () => { setMenuOpen(false); nav('/groups'); } },
                { divider: true },
                { label: '收起桌宠', act: () => { setMenuOpen(false); hide(); } },
              ].map((item, i) =>
                item.divider ? (
                  <div key={`d${i}`} className="my-1 border-t border-slate-100" />
                ) : (
                  <button
                    key={item.label}
                    type="button"
                    onClick={item.act}
                    className="block w-full whitespace-nowrap px-4 py-1.5 text-left text-xs text-slate-600 hover:bg-slate-50"
                  >
                    {item.label}
                  </button>
                ),
              )}
            </div>
          </div>
        )}

        {/* PET-7 双击对话框（贴屏幕上沿时改到本体下方弹出） */}
        {chatOpen && (
          <div className={`absolute ${nearTop ? 'top-full mt-3' : 'bottom-full mb-3'} w-80 ${chatAlign}`}>
            <PetChatPanel msgs={msgs} onSend={send} onClose={() => setChatOpen(false)} />
          </div>
        )}
      </div>
    </div>
  );
}

/** 对话面板（PET-7）：纯展示，逻辑在 Pet 与 lib/petChat.ts */
function PetChatPanel({ msgs, onSend, onClose }: {
  msgs: ChatMsg[];
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs.length]);

  return (
    <div
      className="pet-pop overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl"
      onPointerDown={(e) => e.stopPropagation()}   // 面板里点按不触发拖拽/关菜单
      onContextMenu={(e) => e.stopPropagation()}   // 输入框里保留浏览器右键菜单
    >
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-3.5 py-2">
        <span className="text-sm font-medium text-slate-800">课代表小助手</span>
        <button
          type="button"
          onClick={onClose}
          title="关闭（Esc / 再双击桌宠）"
          className="rounded px-1.5 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          ✕
        </button>
      </div>
      <div ref={listRef} className="max-h-64 space-y-2 overflow-y-auto px-3 py-2.5">
        {msgs.map((m) => (
          <div key={m.id} className={m.role === 'bot' ? 'flex justify-start' : 'flex justify-end'}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-1.5 text-sm leading-relaxed ${
                m.role === 'bot' ? 'rounded-bl-sm border border-slate-200 bg-slate-50 text-slate-700' : 'rounded-br-sm bg-slate-900 text-white'
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 px-3 pb-1.5 pt-1">
        {QUICK_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onSend(q)}
            className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-50 hover:text-slate-800"
          >
            {q}
          </button>
        ))}
      </div>
      <form
        className="flex gap-2 border-t border-slate-100 p-2"
        onSubmit={(e) => { e.preventDefault(); const t = draft.trim(); if (t.length === 0) return; onSend(t); setDraft(''); }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
          placeholder="问日程、截止、群…"
          autoFocus
          className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800 placeholder:text-slate-300 focus:border-indigo-300 focus:outline-none"
        />
        <button type="submit" className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700">
          发送
        </button>
      </form>
    </div>
  );
}

/** 桌宠素材（PET-1）：src/assets/nailong.jpg（奶龙图）。换素材直接替换 assets 里的图片文件即可 */
function PetSprite({ sleeping }: { sleeping: boolean }) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-white shadow-md" style={{ width: SIZE }}>
      <img src={nailongUrl} alt="奶龙桌宠" draggable={false} className="pet-bob block" style={{ width: SIZE }} />
      {/* PET-9 睡觉时的 Zzz 浮标 */}
      {sleeping && (
        <span className="pet-zzz absolute right-2 top-1.5 text-sm font-bold text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">
          z z
        </span>
      )}
    </div>
  );
}

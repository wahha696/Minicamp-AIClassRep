// 网页桌宠：「AI课代表」的看板娘，常驻页面右下角（仅桌面端）。
// 设计决策（编号方便讨论/回滚）：
// - PET-1 素材：src/assets/nailong.jpg（奶龙图，约 1:1 的 JPG，圆角卡片 + 投影展示）；
//   换素材直接替换 assets 里的图片文件即可，行为逻辑不动。
// - PET-2 只在 md+ 显示：手机屏幕小、底部已有 Tab 栏，桌宠会挡内容。
// - PET-3 交互：单击→跳一下并说一句；双击→打开对话框；按住拖动→拎起来，松手弹回地面；
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
import nailongUrl from '../assets/nailong.jpg';
import './pet.css';

const SIZE = 92; // 本体宽度(px)，素材约 1:1，高约 90px
const EDGE = 12; // 左右贴边留白(px)

const STORE_X = 'classrep.pet.x';
const STORE_HIDDEN = 'classrep.pet.hidden';

type Phase = 'idle' | 'walk' | 'drag' | 'drop';

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

export default function Pet() {
  // ===== 位置与姿态 =====
  const [x, setX] = useState<number>(() => {
    const hi = Math.max(EDGE, (typeof window === 'undefined' ? 1280 : window.innerWidth) - SIZE - EDGE);
    const saved = Number(readStore(STORE_X));
    return Number.isFinite(saved) && saved >= EDGE ? clamp(saved, EDGE, hi) : hi; // 默认蹲右下角
  });
  const [lift, setLift] = useState(0);
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
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const menuRef = useRef(menuOpen); menuRef.current = menuOpen;
  const chatOpenRef = useRef(chatOpen); chatOpenRef.current = chatOpen;
  const msgsRef = useRef(msgs); msgsRef.current = msgs;
  const todayRef = useRef(data); todayRef.current = data;
  const connRef = useRef(conn); connRef.current = conn;
  const drag = useRef<{ id: number; px: number; py: number; bx: number; bl: number; moved: boolean } | null>(null);
  const speechTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animSeq = useRef(0);
  const dropSeq = useRef(0);
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
  function pushMsg(role: ChatMsg['role'], text: string) {
    const id = ++msgSeq.current;
    setMsgs((ms) => [...ms, { id, role, text }]); // updater 保持纯净，StrictMode 下也安全
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
    const answer = petReply(text, {
      now: Date.now(),
      summary: t?.summary,
      events: t?.events ?? [],
      connect: connRef.current?.state,
    });
    pushMsg('bot', answer.text);
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
  const walkTo = useCallback((target: number) => {
    if (phaseRef.current !== 'idle') return;
    const [lo, hi] = xRange();
    const t = clamp(target, lo, hi);
    const dist = Math.abs(t - xRef.current);
    if (dist < 12) return;
    const dur = clamp(dist / 90, 0.7, 2.4); // 约 90px/s，快走不磨蹭
    setFacing(t >= xRef.current ? 1 : -1);
    setWalkDur(dur);
    setPhase('walk');
    setX(t);
    window.setTimeout(() => {
      if (phaseRef.current === 'walk') {
        setPhase('idle');
        writeStore(STORE_X, String(Math.round(t)));
      }
    }, dur * 1000 + 100);
  }, [setX]);
  function stroll() {
    const [lo, hi] = xRange();
    walkTo(lo + Math.random() * (hi - lo));
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

  // 随机散步：16~38s 一次概率触发
  useEffect(() => {
    if (hidden) return;
    let alive = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const loop = () => {
      t = setTimeout(() => {
        if (!alive) return;
        if (!document.hidden && phaseRef.current === 'idle' && !menuRef.current && !sleepingRef.current && Math.random() < 0.65) stroll();
        loop();
      }, 16_000 + Math.random() * 22_000);
    };
    loop();
    return () => { alive = false; if (t) clearTimeout(t); };
  }, [hidden]);

  // 窗口变窄时别把自己挤出去
  useEffect(() => {
    const onResize = () => {
      const [lo, hi] = xRange();
      setX(clamp(xRef.current, lo, hi));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setX]);

  // 右键菜单点外面就关
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  // ===== 拖拽/单击/双击（PET-3） =====
  function onBodyPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return; // 右键交给 contextmenu
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 已释放，忽略 */ }
    drag.current = { id: e.pointerId, px: e.clientX, py: e.clientY, bx: x, bl: lift, moved: false };
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
    const [lo, hi] = xRange();
    setX(clamp(d.bx + dx, lo, hi));
    setLift(clamp(d.bl - dy, 0, Math.max(60, window.innerHeight * 0.35)));
  }
  function endDrag(e: ReactPointerEvent<HTMLDivElement>, clicked: boolean) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (phaseRef.current !== 'drag') return;
    if (!d.moved && clicked) {
      setPhase('idle');
      setLift(0);
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
    // 松手：弹回地面 + 落地压扁
    setPhase('drop');
    setLift(0);
    writeStore(STORE_X, String(Math.round(xRef.current)));
    const s = ++dropSeq.current;
    window.setTimeout(() => {
      if (dropSeq.current !== s || phaseRef.current !== 'drop') return;
      setPhase('idle');
      playAnim('land', 470);
    }, 570);
  }
  function playAnim(kind: 'hop' | 'land', ms: number) {
    const s = ++animSeq.current;
    setAnim(kind);
    window.setTimeout(() => { if (animSeq.current === s) setAnim('none'); }, ms);
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

  // 气泡/菜单/对话框贴边时别伸出屏幕外
  const align = x < 150 ? 'left-0' : x > window.innerWidth - 210 ? 'right-0' : 'left-1/2 -translate-x-1/2';
  const chatAlign = x < 165 ? 'left-0' : x > window.innerWidth - 345 ? 'right-0' : 'left-1/2 -translate-x-1/2';

  return (
    <div
      className="fixed bottom-0 left-0 z-30 hidden md:block"
      style={{
        width: SIZE,
        transform: `translate3d(${x}px, 0, 0)`,
        transition: phase === 'walk' ? `transform ${walkDur}s ease-in-out` : 'none',
      }}
    >
      {/* 地面影子：被拎起来时缩小变淡 */}
      <div
        className="absolute bottom-[2px] left-1/2 h-2.5 rounded-[50%] bg-slate-900/15"
        style={{
          width: SIZE * 0.62,
          opacity: Math.max(0.15, 0.8 - (lift / 240) * 0.65),
          transform: `translateX(-50%) scaleX(${1 - (Math.min(lift, 240) / 240) * 0.45})`,
        }}
      />

      {/* 本体：lift 只在这一层；位移全走 transform（PET-6） */}
      <div
        className={`pointer-events-auto absolute bottom-1 left-0 flex touch-none select-none items-end ${
          phase === 'drag' ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        style={{
          transform: `translateY(${-lift}px)`,
          transition: phase === 'drop' ? 'transform 0.55s cubic-bezier(0.3, 1.6, 0.5, 1)' : 'none',
        }}
        onPointerDown={onBodyPointerDown}
        onPointerMove={onBodyPointerMove}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
        onContextMenu={(e) => { e.preventDefault(); setMenuOpen((v) => !v); }}
      >
        {/* 翻面（袖章文字由 pet.css 反向翻回，见 PET-1） */}
        <div
          className={facing === -1 ? 'pet-flipped' : undefined}
          style={{ transform: `scaleX(${facing})`, transition: 'transform 0.25s ease' }}
        >
          <div className={phase === 'walk' ? 'pet-waddle' : anim === 'hop' ? 'pet-hop' : anim === 'land' ? 'pet-land' : undefined}>
            <PetSprite sleeping={sleeping} />
          </div>
        </div>

        {/* 台词气泡（对话框开着时统一走对话框，见 PET-8） */}
        {speech && (
          <div className={`absolute bottom-full mb-3 ${align}`} aria-live="polite">
            <div
              key={speech.id}
              className="pet-pop pointer-events-none relative w-max max-w-56 rounded-2xl border border-slate-200 bg-white px-3.5 py-2 text-sm leading-relaxed text-slate-700 shadow-lg"
            >
              {speech.text}
              <span className="absolute -bottom-[7px] left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-b border-r border-slate-200 bg-white" />
            </div>
          </div>
        )}

        {/* 右键菜单 */}
        {menuOpen && (
          <div className={`absolute bottom-full mb-9 ${align}`} onPointerDown={(e) => e.stopPropagation()}>
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

        {/* PET-7 双击对话框 */}
        {chatOpen && (
          <div className={`absolute bottom-full mb-3 w-80 ${chatAlign}`}>
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

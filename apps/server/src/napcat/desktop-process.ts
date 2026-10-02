import { execFile, spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { findQQExe } from './paths.js';
import type { DesktopQQHandle } from './desktop-session.js';

const run = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export interface QQProcess { pid: number; started: string; started_ms: number; visible: boolean }

// Use exact executable locations, not /IM QQ.exe, to leave unrelated QQ installations alone.
const QUERY = `$ErrorActionPreference='Stop';
$exe=$env:CLASSREP_DESKTOP_QQ_EXE;
$versions=[IO.Path]::Combine((Split-Path -Parent $exe),'versions')+'\\';
$found=@(Get-Process -Name QQ -ErrorAction SilentlyContinue | ForEach-Object {
  if($_.Threads.Count -eq 0){return};
  $path=$_.Path;
  if(-not $path){throw 'Cannot inspect QQ process; check QQ privilege level'};
  if($path -ieq $exe -or $path.StartsWith($versions,[StringComparison]::OrdinalIgnoreCase)){
    [pscustomobject]@{pid=$_.Id;started=$_.StartTime.ToUniversalTime().Ticks.ToString();
      started_ms=[Math]::Floor(($_.StartTime.ToUniversalTime()-[DateTime]'1970-01-01').TotalMilliseconds);
      visible=($_.MainWindowHandle -ne [IntPtr]::Zero)}
  }
}); ConvertTo-Json -InputObject $found -Compress`;

export async function queryQQProcesses(exe: string): Promise<QQProcess[]> {
  try {
    const result = await run('powershell.exe', ['-NoProfile', '-Command', QUERY], {
      windowsHide: true, timeout: 8_000, encoding: 'utf8',
      env: { ...process.env, CLASSREP_DESKTOP_QQ_EXE: exe },
    });
    const data: unknown = JSON.parse(result.stdout.trim());
    if (!Array.isArray(data)) throw new Error('Invalid process snapshot');
    return data as QQProcess[];
  } catch {
    throw new Error('无法检测 QQ 的运行状态。请确认 QQ 与 ClassRep 使用相同的运行权限，且系统 PowerShell 可用后重试');
  }
}

export async function waitForQQExit(exe: string, timeoutMs = 12_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  do {
    if ((await queryQQProcesses(exe)).length === 0) return;
    await sleep(300);
  } while (Date.now() < until);
  throw new Error('QQ 尚未完全退出，无法切换。请关闭 QQ 后点击“返回ClassRep”重试');
}

/** Logged-in launchers may exit after handing over to versions/<version>/QQ.exe. */
export function createQQHandle(
  snapshot: () => Promise<QQProcess[]>,
  terminate: (pid: number) => Promise<void>,
  launchedAt: number,
): DesktopQQHandle {
  const owned = new Map<number, string>();
  let everVisible = false;
  let hiddenChecks = 0;
  const alive = async () => {
    const processes = await snapshot();
    for (const process of processes) {
      // Bind identity with creation time too: a reused PID must never be killed.
      if (process.started_ms >= launchedAt - 1000 && process.started_ms <= launchedAt + 30_000 && !owned.has(process.pid)) {
        owned.set(process.pid, process.started);
      }
    }
    return processes.filter((process) => owned.get(process.pid) === process.started);
  };
  return {
    async poll() {
      const processes = await alive();
      if (processes.length === 0) return 'closed';
      const visible = processes.some((process) => process.visible);
      if (visible) { everVisible = true; hiddenChecks = 0; }
      else hiddenChecks++;
      // A minimized window keeps its MainWindowHandle; closing to the tray clears it.
      return everVisible && hiddenChecks >= 2 ? 'closed' : 'open';
    },
    async close() {
      for (const process of await alive()) await terminate(process.pid);
      // Do not report recovery until the processes and the single-instance lock are gone.
      for (let attempt = 0; attempt < 20; attempt++) {
        if ((await alive()).length === 0) return;
        await sleep(300);
      }
      throw new Error('QQ 未能退出，请手动退出后再返回 ClassRep');
    },
  };
}

// Only click cached-account login if the requested UIN can be identified in QQ's login UI.
// Never type a password or select another cached account. Expired authorization still needs QQ verification.
const QUICK_LOGIN = `$ErrorActionPreference='Stop';
Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes;
$expected=$env:CLASSREP_DESKTOP_QQ_UIN;
$pids=$env:CLASSREP_DESKTOP_QQ_PIDS.Split(',');
$root=[Windows.Automation.AutomationElement]::RootElement;
$deadline=[DateTime]::UtcNow.AddSeconds(8);
do {
foreach($window in $root.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)){
 if($pids -notcontains $window.Current.ProcessId.ToString()){continue};
 $elements=$window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition);
 $login=$null;$account=$null;$accounts=@();
 foreach($element in $elements){
  $name=$element.Current.Name;
  if($name -match '^\\d{5,12}$'){$accounts+=$name;if($name -eq $expected){$account=$element}};
  if($name -match '^登\\s*录(?:QQ)?$' -and $element.Current.IsEnabled){$login=$element}
 };
 if(-not $login -or -not $account){continue};
 $selection=$null;$selected=$false;
 if($account.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$selection)){
  $selection.Select();$selected=$true
 };
 if(-not $selected -and ($accounts.Count -ne 1 -or $accounts[0] -ne $expected)){continue};
 $invoke=$null;
 if($login.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)){$invoke.Invoke();return}
};
Start-Sleep -Milliseconds 400
} while([DateTime]::UtcNow -lt $deadline)`;

export async function openDesktopQQ(uin: string): Promise<DesktopQQHandle> {
  const exe = findQQExe();
  if (!exe) throw new Error('需要先安装 QQ 电脑版');
  await waitForQQExit(exe);
  const launchedAt = Date.now();
  // The normal QQ GUI, using its saved profile; -q is a NapCat-only option.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(NAPCAT_|LLM_|TYPESAFE_|FASTJUDGE_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(key)));
  const child = spawn(exe, ['--force-renderer-accessibility'], {
    cwd: dirname(exe), env, detached: true, stdio: 'ignore', windowsHide: false,
  });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  const terminate = async (pid: number) => {
    try { await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }); }
    catch (error) {
      if ((await queryQQProcesses(exe)).some((process) => process.pid === pid)) throw error;
    }
  };
  const handle = createQQHandle(() => queryQQProcesses(exe), terminate, launchedAt);
  const deadline = launchedAt + 30_000;
  while (Date.now() < deadline) {
    const processes = await queryQQProcesses(exe);
    if (processes.some((process) => process.started_ms >= launchedAt - 1000 && process.visible)) {
      await handle.poll(); // Remember the visible window even if the user closes it immediately.
      // Best-effort cached login. UI differences must not prevent using the normal QQ window.
      void run('powershell.exe', ['-NoProfile', '-Command', QUICK_LOGIN], {
        windowsHide: true, timeout: 10_000,
        env: { ...env, CLASSREP_DESKTOP_QQ_UIN: uin, CLASSREP_DESKTOP_QQ_PIDS: processes.map((p) => p.pid).join(',') },
      }).catch(() => {});
      return handle;
    }
    await sleep(500);
  }
  if ((await queryQQProcesses(exe)).some((process) => process.started_ms >= launchedAt - 1000)) return handle;
  throw new Error('电脑版 QQ 未能启动，请检查 QQ 是否正常安装');
}

export async function ensureDesktopQQExited(): Promise<void> {
  const exe = findQQExe();
  if (!exe) throw new Error('需要先安装 QQ 电脑版');
  await waitForQQExit(exe);
}

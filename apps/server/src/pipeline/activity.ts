// Independent of account-switch quiescing: switching accounts cannot undo a QQ pause.
let paused = false;
let epoch = 0;
export function setDesktopPipelinePaused(next: boolean): void {
  if (paused === next) return;
  paused = next;
  epoch++;
}
export function desktopPipelinePaused(): boolean { return paused; }
export function desktopPipelineEpoch(): number { return epoch; }

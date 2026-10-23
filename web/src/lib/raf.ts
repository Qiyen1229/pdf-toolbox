/**
 * 背景分頁中 requestAnimationFrame 會被瀏覽器完全暫停，pdf.js 的繪製因此停住
 * （例如使用者在長時間 OCR / 批次處理時切到別的分頁）。
 * 這裡在分頁隱藏時改用計時器排程：速度會被瀏覽器節流，但處理能持續進行。
 */
const nativeRaf = window.requestAnimationFrame.bind(window);
const nativeCancel = window.cancelAnimationFrame.bind(window);
const timers = new Map<number, number>();
let next = 1_000_000_000;

window.requestAnimationFrame = (cb: FrameRequestCallback) => {
  if (!document.hidden) return nativeRaf(cb);
  const id = next++;
  timers.set(id, window.setTimeout(() => { timers.delete(id); cb(performance.now()); }, 16));
  return id;
};
window.cancelAnimationFrame = (id: number) => {
  const t = timers.get(id);
  if (t !== undefined) { clearTimeout(t); timers.delete(id); } else nativeCancel(id);
};

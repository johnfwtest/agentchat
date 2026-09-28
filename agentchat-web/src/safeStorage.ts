/**
 * safeStorage:兜底 iPad Safari 隐私模式 / 长期未访问站点的 localStorage 异常。
 *
 * 背景:iPadOS Safari 的 Private Browsing 模式对 localStorage.setItem 抛
 * QuotaExceededError;部分边界场景(getItem 在某些路径)抛 SecurityError。
 * 若任由异常向上抛,React 应用在模块加载阶段就会崩 → 白屏。
 *
 * 用法:替代裸调 localStorage,所有读写都走这里。失败一律降级为空值,
 * 配合应用已有的"网络/持久化能力 = best effort"语义一致。
 */

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function safeSet(key: string, value: string): boolean {
  try { localStorage.setItem(key, value); return true } catch { return false }
}
function safeRemove(key: string): void {
  try { localStorage.removeItem(key) } catch { /* 忽略 */ }
}
function safeGetJSON<T>(key: string, fallback: T): T {
  const raw = safeGet(key)
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}
function safeSetJSON(key: string, value: unknown): boolean {
  try { return safeSet(key, JSON.stringify(value)) } catch { return false }
}

export const safeStorage = {
  get: safeGet,
  set: safeSet,
  remove: safeRemove,
  getJSON: safeGetJSON,
  setJSON: safeSetJSON,
}
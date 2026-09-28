import { create } from 'zustand'
import {
  ConvItem, Msg, UserItem, fetchConvs, fetchMessages, fetchThinks, fetchUsers,
  getToken, setToken, clearToken,
  login as apiLogin,
} from './api'
import { wsConnect, wsDisconnect } from './ws'
import { safeStorage } from './safeStorage'

export interface Highlight { convId: string; seq: number }
export interface ThinkState { sender: string; id?: string; text: string; at: string; done?: boolean }

const READ_KEY = 'agentchat_read'      // {convId: seq}
const MENTION_KEY = 'agentchat_mention' // [convId] 有未读 @我
// 顶层模块初始化:iPad Safari 隐私模式 / 长期未访问站点会让 localStorage 抛
// QuotaExceededError / SecurityError,这里原本裸调 JSON.parse(localStorage.getItem)
// 会在模块加载阶段就崩 → 整个 React 应用白屏。改走 safeStorage 兜底为默认值,
// 应用继续工作,只是不会记住"上次看到哪条 / @我未读"而已(可接受的退化)。
const readSeqMap: Record<string, number> = safeStorage.getJSON(READ_KEY, {})
let mentionUnread: string[] = safeStorage.getJSON(MENTION_KEY, [])

// 消息区是否贴底（MessageList 维护，onEvent 判断自己发的消息算不算未读用）
export const scrollState = { atBottom: true }

interface Store {
  me: { username: string; role: string } | null
  convs: ConvItem[]
  users: UserItem[]                   // 全员在线状态（30s 轮询，私聊小点用）
  activeConvId: string | null
  messages: Record<string, Msg[]>      // convId -> 升序消息（当前加载的连续窗口）
  hasMore: Record<string, boolean>     // convId -> 前面还有更早的段
  hasMoreAfter: Record<string, boolean> // convId -> 后面还有更新的段（看旧段时）
  loadingHistory: boolean
  replyTo: Msg | null
  scrollSignal: number               // 点击会话时 +1，驱动消息区强制贴底
  readVersion: number                // readSeq/mention 变化时 +1，驱动会话列表重算红点
  highlight: Highlight | null        // 历史查询跳转定位的高亮消息
  thinks: Record<string, Record<string, ThinkState>> // convId -> sender -> 进行中的思考流（瞬态，不入库）
  mediaViewer: { type: 'image' | 'video'; src: string; alt?: string } | null // 消息媒体查看器（全局，与消息流重渲染解耦）
  msgAtBottom: boolean                  // 消息区是否在最新消息位置（标题栏动态高度用）
  convOpenTick: number                  // openConv 被调用的次数（含重复点同一会话——移动端切视图信号）
  openMediaViewer: (v: { type: 'image' | 'video'; src: string; alt?: string }) => void
  closeMediaViewer: () => void
  setMsgAtBottom: (v: boolean) => void
  login: (u: string, p: string) => Promise<void>
  logout: () => void
  loadConvs: () => Promise<void>
  loadUsers: () => Promise<void>
  openConv: (convId: string) => Promise<void>
  jumpToMessage: (convId: string, seq: number) => Promise<void>
  clearHighlight: () => void
  loadHistory: (convId: string) => Promise<void>
  loadAfter: (convId: string) => Promise<void>
  loadLatest: (convId: string) => Promise<void>
  setActive: (convId: string | null) => void
  setReplyTo: (m: Msg | null) => void
  onEvent: (ev: any) => void
  onThink: (ev: any) => void
  clearThink: (convId: string, sender: string) => void
  loadThinks: (convId: string) => Promise<void>
}

// readSeq/mention 存在模块变量里（非响应式），变更时 bump readVersion 触发列表重渲染
function bumpReadVersion() {
  useStore.setState(s => ({ readVersion: s.readVersion + 1 }))
}
function persistRead(convId: string, seq: number) {
  readSeqMap[convId] = seq
  safeStorage.setJSON(READ_KEY, readSeqMap)
  bumpReadVersion()
}
function persistMention() {
  safeStorage.setJSON(MENTION_KEY, mentionUnread)
  bumpReadVersion()
}
export const getReadSeq = (convId: string) => readSeqMap[convId] || 0
export const hasMentionUnread = (convId: string) => mentionUnread.includes(convId)

export const useStore = create<Store>((set, get) => ({
  me: null,
  convs: [],
  users: [],
  activeConvId: null,
  messages: {},
  hasMore: {},
  hasMoreAfter: {},
  loadingHistory: false,
  replyTo: null,
  scrollSignal: 0,
  readVersion: 0,
  highlight: null,
  thinks: {},
  mediaViewer: null,
  msgAtBottom: true,

  convOpenTick: 0,

  openMediaViewer: (v) => set({ mediaViewer: v }),
  closeMediaViewer: () => set({ mediaViewer: null }),
  // 值不变不 set：onScroll 高频调用，避免无谓的订阅通知
  setMsgAtBottom: (v) => { if (get().msgAtBottom !== v) set({ msgAtBottom: v }) },

  login: async (u, p) => {
    const r = await apiLogin(u, p)
    setToken(r.token)
    set({ me: { username: r.username, role: r.role } })
    wsConnect(r.token)
    await get().loadConvs()
    startUserPolling()
  },

  logout: () => {
    wsDisconnect()
    stopUserPolling()
    clearToken()
    set({ me: null, convs: [], users: [], activeConvId: null,
          messages: {}, replyTo: null, thinks: {}, mediaViewer: null,
          hasMore: {}, hasMoreAfter: {} })
  },

  loadConvs: async () => {
    const r = await fetchConvs()
    set({ convs: r.conversations })
  },

  loadUsers: async () => {
    try { set({ users: (await fetchUsers()).users }) } catch { /* 忽略轮询失败 */ }
  },

  setActive: (convId) => {
    set({ activeConvId: convId, replyTo: null })
    if (convId) {
      const conv = get().convs.find(c => c.id === convId)
      if (conv) {
        persistRead(convId, Math.max(getReadSeq(convId), conv.last_seq))
        mentionUnread = mentionUnread.filter(c => c !== convId)
        persistMention()
      }
    }
  },

  openConv: async (convId) => {
    set({ convOpenTick: get().convOpenTick + 1 })   // 显式信号：每次点击都触发（含同一会话）
    get().setActive(convId)
    set({ scrollSignal: get().scrollSignal + 1 })   // 即使重开当前会话也强制贴底
    if (!get().messages[convId]) await get().loadHistory(convId)
    get().loadThinks(convId)                        // 切换/刷新后拉回进行中的思考流
  },

  // 历史查询跳转：定位到某条消息所在的**对齐分段**（seq 寻址，服务端按
  // msg_page_size 对齐，如 seq=1134 段大小 100 → 加载 1101~1200），贴底+高亮
  jumpToMessage: async (convId, seq) => {
    location.hash = '#/'
    get().setActive(convId)
    const r = await fetchMessages(convId, { seq })
    set({ messages: { ...get().messages, [convId]: r.messages },
          hasMore: { ...get().hasMore, [convId]: r.has_more },
          hasMoreAfter: { ...get().hasMoreAfter, [convId]: r.has_more_after ?? false },
          scrollSignal: get().scrollSignal + 1,
          highlight: { convId, seq } })
  },

  clearHighlight: () => set({ highlight: null }),

  loadHistory: async (convId) => {
    if (get().loadingHistory) return
    set({ loadingHistory: true })
    try {
      const existing = get().messages[convId] || []
      // 不传 limit → 服务端按 msg_page_size 返回一整段
      const params: Record<string, number> = existing.length
        ? { before_seq: existing[0].seq }
        : {}
      const r = await fetchMessages(convId, params)
      const merged = existing.length
        ? [...r.messages, ...existing]
        : r.messages
      // 按 seq 去重排序
      const seen = new Set<number>()
      const uniq = merged.filter(m => !seen.has(m.seq) && seen.add(m.seq))
      uniq.sort((a, b) => a.seq - b.seq)
      set({ messages: { ...get().messages, [convId]: uniq },
            hasMore: { ...get().hasMore, [convId]: r.has_more },
            hasMoreAfter: { ...get().hasMoreAfter, [convId]: r.has_more_after ?? false } })
    } finally {
      set({ loadingHistory: false })
    }
  },

  // 向后翻段：加载当前窗口之后的一段（贴着窗口底向下滚动时触发）
  loadAfter: async (convId) => {
    if (get().loadingHistory) return
    const existing = get().messages[convId] || []
    if (!existing.length) return
    set({ loadingHistory: true })
    try {
      const r = await fetchMessages(convId, { after_seq: existing[existing.length - 1].seq })
      const merged = [...existing, ...r.messages]
      const seen = new Set<number>()
      const uniq = merged.filter(m => !seen.has(m.seq) && seen.add(m.seq))
      uniq.sort((a, b) => a.seq - b.seq)
      set({ messages: { ...get().messages, [convId]: uniq },
            hasMoreAfter: { ...get().hasMoreAfter, [convId]: r.has_more_after ?? false } })
    } finally {
      set({ loadingHistory: false })
    }
  },

  // 直达最后一段（跳底按钮在"看旧段"时使用）：整体替换为最新窗口并强制贴底
  loadLatest: async (convId) => {
    const r = await fetchMessages(convId, {})
    set({ messages: { ...get().messages, [convId]: r.messages },
          hasMore: { ...get().hasMore, [convId]: r.has_more },
          hasMoreAfter: { ...get().hasMoreAfter, [convId]: false },
          scrollSignal: get().scrollSignal + 1 })
  },

  setReplyTo: (m) => set({ replyTo: m }),

  onEvent: (ev) => {
    if (ev.type !== 'message') return
    const m: Msg = ev.message
    const state = get()
    // 消息流缓存（已加载过该会话）：仅无缝续接（seq 恰为窗口末尾+1）才追加；
    // 看旧段时更晚的消息不制造空洞，只标记"后面还有段"（跳底按钮会加载最后一段）
    if (state.messages[m.conv_id]) {
      const arr = state.messages[m.conv_id]
      if (!arr.some(x => x.seq === m.seq)) {
        const tail = arr.length ? arr[arr.length - 1].seq : 0
        if (m.seq === tail + 1) {
          const next = [...arr, m].sort((a, b) => a.seq - b.seq)
          set({ messages: { ...state.messages, [m.conv_id]: next } })
        } else if (m.seq > tail) {
          set({ hasMoreAfter: { ...get().hasMoreAfter, [m.conv_id]: true } })
        }
      }
    }
    // 会话列表更新
    const convs = state.convs.map(c => c.id === m.conv_id ? {
      ...c,
      last_seq: Math.max(c.last_seq, m.seq),
      last_msg: { seq: m.seq, sender: m.sender,
                  preview: m.type === 'system' ? m.content : m.content.slice(0, 50),
                  at: m.created_at || '' },
    } : c)
    set({ convs })
    // 正式消息到达 = 该 sender 的思考流结束，自动清除其 think 气泡
    const th = get().thinks[m.conv_id]
    if (th?.[m.sender]) {
      const ct = { ...th }
      delete ct[m.sender]
      set({ thinks: { ...get().thinks, [m.conv_id]: ct } })
    }
    // 未读 / @我 提醒：
    // - 自己发的消息，会话打开且消息区贴底时不计未读（readSeq 跟上自己的 seq）
    // - 别人发的消息一律计未读红点（哪怕正贴底看着），点击房间清除
    const me = state.me?.username
    if (me && m.sender === me) {
      if (m.conv_id === state.activeConvId && scrollState.atBottom)
        persistRead(m.conv_id, m.seq)
    } else if (me) {
      const isPrivate = m.conv_id.startsWith('private:')
      const mentioned = m.mentions.includes(me) || m.mentions.includes('all')
      if (isPrivate || mentioned) {
        if (!mentionUnread.includes(m.conv_id)) mentionUnread.push(m.conv_id)
        persistMention()
        notify(m, isPrivate, mentioned)
      }
    }
  },

  onThink: (ev) => {
    const { conv_id, sender, id, text, at, done } = ev
    const cur = get().thinks[conv_id]?.[sender]
    if (cur && (cur.at || '') > (at || '')) return   // 乱序到达的旧快照，忽略
    const convThinks = { ...(get().thinks[conv_id] || {}) }
    if (!text && !done) delete convThinks[sender]    // 空文本 = 主动清除
    else convThinks[sender] = { sender, id, text, at: at || '', done }
    set({ thinks: { ...get().thinks, [conv_id]: convThinks } })
  },

  clearThink: (convId, sender) => {
    const th = get().thinks[convId]
    if (!th?.[sender]) return
    const ct = { ...th }
    delete ct[sender]
    set({ thinks: { ...get().thinks, [convId]: ct } })
  },

  loadThinks: async (convId) => {
    // 按需拉取（瞬态快照，尽力而为）：与实时事件按 at 时间合并
    try {
      const r = await fetchThinks(convId)
      const cur = get().thinks[convId] || {}
      const next = { ...cur }
      for (const t of r.thinks)
        if (!cur[t.sender] || (cur[t.sender].at || '') <= (t.at || ''))
          next[t.sender] = t
      set({ thinks: { ...get().thinks, [convId]: next } })
    } catch { /* 忽略 */ }
  },
}))

function notify(m: Msg, isPrivate: boolean, mentioned: boolean) {
  if (document.hasFocus() && !document.hidden) return
  if (!('Notification' in window)) return
  if (Notification.permission === 'default') Notification.requestPermission()
  if (Notification.permission !== 'granted') return
  const title = mentioned ? `@你 · ${m.sender}` : `${m.sender}`
  const n = new Notification(title, {
    body: m.content.slice(0, 100),
    tag: m.conv_id,
  })
  n.onclick = () => {
    window.focus()
    useStore.getState().openConv(m.conv_id)
    n.close()
  }
  if (isPrivate) {
    try {
      const ctx = new AudioContext()
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.connect(g); g.connect(ctx.destination)
      o.frequency.value = 880
      g.gain.setValueAtTime(0.08, ctx.currentTime)
      o.start(); o.stop(ctx.currentTime + 0.12)
    } catch { /* 忽略 */ }
  }
}

export function bootFromToken() {
  const t = getToken()
  if (!t) return false
  import('./api').then(async ({ fetchMe }) => {
    try {
      const me = await fetchMe()
      useStore.setState({ me })
      wsConnect(t)
      await useStore.getState().loadConvs()
      startUserPolling()
    } catch {
      clearToken()
    }
  })
  return true
}

// 在线状态轮询：30s 一次轻量 GET（服务端仅每用户 2 个 Redis 查询）
let usersTimer: ReturnType<typeof setInterval> | undefined
export function startUserPolling() {
  if (usersTimer) return
  useStore.getState().loadUsers()
  usersTimer = setInterval(() => useStore.getState().loadUsers(), 30000)
}
export function stopUserPolling() {
  if (usersTimer) { clearInterval(usersTimer); usersTimer = undefined }
}

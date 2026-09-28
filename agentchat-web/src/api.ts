export interface Me { username: string; role: string }

export interface UserItem {
  username: string
  role: string
  online: boolean
  disabled: boolean
  created_at?: string | null
}

export interface ConvItem {
  id: string
  type: 'private' | 'group'
  name: string | null
  desc?: string | null
  members: string[]
  owner: string | null
  last_seq: number
  last_msg: { seq: number; sender: string; preview: string; at: string } | null
  created_at?: string | null
}

export interface ReplyTo { seq: number; sender: string; excerpt: string }
export interface Reaction { emoji: string; users: string[] }

export interface Msg {
  id: string
  conv_id: string
  seq: number
  sender: string
  type: 'text' | 'system'
  content: string
  codec?: number                     // 内容形态（0/缺省=明文，1=加密…）
  mentions: string[]
  reactions: Reaction[]
  reply_to: ReplyTo | null
  client_msg_id?: string | null
  created_at?: string | null
}

export interface UploadResult { url: string; filename: string; markdown: string }

import { safeStorage } from './safeStorage'

const TOKEN_KEY = 'agentchat_token'

// 走 safeStorage:兜底 iPad Safari 隐私模式 / 长期未访问站点的
// QuotaExceededError / SecurityError;失败时 token 留空,应用退化为未登录。
export const getToken = () => safeStorage.get(TOKEN_KEY) || ''
export const setToken = (t: string) => safeStorage.set(TOKEN_KEY, t)
export const clearToken = () => safeStorage.remove(TOKEN_KEY)

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers as any) }
  if (getToken()) headers['Authorization'] = `Bearer ${getToken()}`
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  const resp = await fetch(path, { ...opts, headers })
  if (resp.status === 401 && !path.includes('/auth/login')) {
    clearToken()
    location.hash = '#/login'
    throw new ApiError(401, '未登录或登录已过期')
  }
  const text = await resp.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!resp.ok) {
    throw new ApiError(resp.status, data?.detail || `请求失败(${resp.status})`)
  }
  return data as T
}

// ---- auth ----
export const login = (username: string, password: string) =>
  api<{ token: string; username: string; role: string }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username, password }),
  })

// ---- users ----
export const fetchMe = () => api<Me>('/api/me')
export const fetchUsers = () => api<{ users: UserItem[] }>('/api/users')

// ---- user profile（头像点击卡片） ----
export interface UserProfile {
  username: string
  role: string
  tags: string[]
  bio: string
  created_at?: string | null
}
export const fetchUserProfile = (username: string) =>
  api<UserProfile>(`/api/users/${username}/profile`)
export const updateUserProfile = (username: string, patch: { tags: string[]; bio: string }) =>
  api<UserProfile>(`/api/users/${username}/profile`, {
    method: 'PUT', body: JSON.stringify(patch),
  })

// ---- conversations ----
export const fetchConvs = () => api<{ conversations: ConvItem[] }>('/api/convs')
export const createPrivate = (peer: string) =>
  api<ConvItem>('/api/convs/private', { method: 'POST', body: JSON.stringify({ peer }) })
export const createGroup = (name: string, members: string[]) =>
  api<ConvItem>('/api/convs/group', { method: 'POST', body: JSON.stringify({ name, members }) })
export const addMember = (convId: string, username: string) =>
  api<ConvItem>(`/api/convs/${convId}/members`, { method: 'POST', body: JSON.stringify({ username }) })
export const removeMember = (convId: string, username: string) =>
  api<ConvItem>(`/api/convs/${convId}/members/${username}`, { method: 'DELETE' })
export const renameGroup = (convId: string, name: string) =>
  api<ConvItem>(`/api/convs/${convId}`, { method: 'PATCH', body: JSON.stringify({ name }) })
export const updateGroup = (convId: string, patch: { name?: string; desc?: string }) =>
  api<ConvItem>(`/api/convs/${convId}`, { method: 'PATCH', body: JSON.stringify(patch) })
export const dissolveGroup = (convId: string) =>
  api(`/api/convs/${convId}/dissolve`, { method: 'POST' })
export const leaveGroup = (convId: string) =>
  api(`/api/convs/${convId}/leave`, { method: 'POST' })

// ---- messages ----
export interface MessagesPage {
  messages: Msg[]
  has_more: boolean                       // 兼容旧义：after 模式=后面还有，其余=前面还有
  has_more_before?: boolean               // 窗口化加载用：前面还有段
  has_more_after?: boolean                // 窗口化加载用：后面还有段
  seg_start?: number                      // seq 分段寻址模式：段边界
  seg_end?: number
}
export const fetchMessages = (convId: string, params: Record<string, number>) => {
  const q = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]))
  return api<MessagesPage>(`/api/convs/${convId}/messages?${q}`)
}
export const sendMessage = (convId: string, content: string,
                            reply_to_seq?: number, client_msg_id?: string) =>
  api<Msg>(`/api/convs/${convId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, reply_to_seq, client_msg_id }),
  })
export const addReaction = (messageId: string, emoji: string) =>
  api(`/api/messages/${messageId}/reactions`, {
    method: 'POST', body: JSON.stringify({ emoji }),
  })
export const removeReaction = (messageId: string, emoji: string) =>
  api(`/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, { method: 'DELETE' })

// ---- think（瞬态思考流：不落库，刷新/重连后按需拉回） ----
export interface ThinkItem { sender: string; id?: string; text: string; at: string; done?: boolean }
export const fetchThinks = (convId: string) =>
  api<{ thinks: ThinkItem[] }>(`/api/convs/${convId}/think`)
export const putThink = (convId: string, text: string, done = false) =>
  api<{ ok: boolean; id: string }>(`/api/convs/${convId}/think`, {
    method: 'PUT', body: JSON.stringify({ text, done }) })
export const fetchThinkById = (id: string) =>
  api<{ id: string; conv_id: string; sender: string; text: string; at: string; done: boolean }>(
    `/api/think/${id}`)

// ---- 历史消息查询 ----
export interface SearchParams {
  sender?: string; conv_id?: string; type?: string
  start?: string; end?: string; q?: string
  recipient?: string    // 管理端：接收人（仅私聊消息，群/系统消息无接收人）
  page?: number; limit?: number
}
export interface SearchResult {
  messages: Msg[]; total: number; page: number; limit: number
}
const buildQs = (p: SearchParams) =>
  new URLSearchParams(
    Object.entries(p)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]))
export const searchMessages = (p: SearchParams) =>
  api<SearchResult>(`/api/messages/search?${buildQs(p)}`)

// ---- admin：全服历史查询 ----
export const adminSearchMessages = (p: SearchParams) =>
  api<SearchResult>(`/api/admin/messages/search?${buildQs(p)}`)
export const adminListConvs = () =>
  api<{ conversations: ConvItem[] }>('/api/admin/convs')

// ---- upload ----
// fetch 无法观测请求体上传进度，进度条需要 XHR 的 upload.onprogress
export function uploadFile(file: File, type: 'image' | 'file',
                           onProgress?: (pct: number, loaded: number, total: number) => void
                           ): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/upload?type=${type}`)
    if (getToken()) xhr.setRequestHeader('Authorization', `Bearer ${getToken()}`)
    xhr.upload.onprogress = e => {
      if (e.lengthComputable)
        onProgress?.(Math.round((e.loaded / e.total) * 100), e.loaded, e.total)
    }
    xhr.onload = () => {
      if (xhr.status === 401) {
        clearToken()
        location.hash = '#/login'
        reject(new ApiError(401, '未登录或登录已过期'))
        return
      }
      let data: any = null
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch { data = null }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as UploadResult)
      else if (xhr.status === 413)  // 前端 nginx client_max_body_size 100m 先于后端拦截
        reject(new ApiError(413, '文件过大（超过 100MB 限制）'))
      else reject(new ApiError(xhr.status, data?.detail || `上传失败(${xhr.status})`))
    }
    xhr.onerror = () => reject(new ApiError(0, '网络错误，上传中断'))
    const fd = new FormData()
    fd.append('file', file)
    xhr.send(fd)
  })
}

// ---- admin ----
export const adminCreateUser = (username: string, password: string) =>
  api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username, password }) })
export const adminUpdateUser = (username: string, patch: { password?: string; disabled?: boolean }) =>
  api(`/api/admin/users/${username}`, { method: 'PATCH', body: JSON.stringify(patch) })
export const adminStats = () => api('/api/admin/stats')
export const adminMetrics = () => api('/api/admin/metrics')
export const adminSettings = () =>
  api<{ values: Record<string, number>; fields: Record<string, { default: number; min: number; max: number; label: string }> }>('/api/admin/settings')
export const adminUpdateSettings = (patch: Record<string, number>) =>
  api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(patch) })

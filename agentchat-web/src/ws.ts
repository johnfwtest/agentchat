import { useStore } from './store'

let ws: WebSocket | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null
let retry = 0
let wantConnected = false

export function wsConnect(token: string) {
  wantConnected = true
  open(token)
}

function open(token: string) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const host = location.port === '5173' ? location.hostname + ':8000' : location.host
  ws = new WebSocket(`${proto}://${host}/api/ws?token=${token}`)

  ws.onopen = () => {
    retry = 0
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
    }, 30000)
  }

  ws.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data)
      const store = useStore.getState()
      if (ev.type === 'message') store.onEvent(ev)
      else if (ev.type === 'think') store.onThink(ev)
      else if (ev.type === 'reaction') handleReaction(ev.reaction)
      else if (ev.type === 'ready') handleReady(ev.convs)
      else if (ev.type === 'kick') store.logout()
    } catch { /* 忽略非 JSON */ }
  }

  ws.onclose = () => {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
    if (!wantConnected) return
    retry = Math.min(retry + 1, 6)
    setTimeout(() => open(token), Math.min(1000 * 2 ** retry, 60000))
  }
}

export function wsDisconnect() {
  wantConnected = false
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
  ws?.close()
  ws = null
}

/** ready 快照对账：发现某会话比本地缓存新，直接重拉历史。 */
async function handleReady(convs: { conv_id: string; last_seq: number }[]) {
  const store = useStore.getState()
  await store.loadConvs()
  // 重连后拉回当前会话进行中的思考流（瞬态，只在此尽力恢复）
  if (store.activeConvId) store.loadThinks(store.activeConvId)
  for (const c of convs) {
    const cached = store.messages[c.conv_id]
    if (cached && cached.length && cached[cached.length - 1].seq < c.last_seq) {
      const { fetchMessages } = await import('./api')
      try {
        const r = await fetchMessages(c.conv_id, {
          after_seq: cached[cached.length - 1].seq, limit: 200 })
        const merged = [...cached, ...r.messages].sort((a, b) => a.seq - b.seq)
        const seen = new Set<number>()
        const uniq = merged.filter(m => !seen.has(m.seq) && seen.add(m.seq))
        useStore.setState(s => ({
          messages: { ...s.messages, [c.conv_id]: uniq },
        }))
      } catch { /* 忽略 */ }
    }
  }
}

/** reaction 事件：替换对应消息的 reactions 字段。 */
function handleReaction(r: any) {
  useStore.setState(s => {
    const arr = s.messages[r.conv_id]
    if (!arr) return s
    return {
      messages: {
        ...s.messages,
        [r.conv_id]: arr.map(m => m.id === r.message_id
          ? { ...m, reactions: r.reactions } : m),
      },
    }
  })
}

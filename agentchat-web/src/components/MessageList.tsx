import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Avatar, Button, Tooltip } from 'antd'
import { DownOutlined, LikeOutlined } from '@ant-design/icons'
import { Msg } from '../api'
import { useStore, scrollState } from '../store'
import { t as tt, useLang } from '../i18n'
import { useIsMobile } from '../responsive'
import { msgTime } from '../time'
import { convColor } from './ConvList'
import Markdown from './Markdown'
import ThinkBubble from './ThinkBubble'
import UserProfileCard from './UserProfileCard'

const QUICK_EMOJIS = ['👍', '✅', '🎉', '❤️']

export default function MessageList() {
  const activeConvId = useStore(s => s.activeConvId)
  const messages = useStore(s => s.messages)
  const hasMore = useStore(s => s.hasMore)
  const hasMoreAfter = useStore(s => s.hasMoreAfter)
  const loadingHistory = useStore(s => s.loadingHistory)
  const loadHistory = useStore(s => s.loadHistory)
  const loadAfter = useStore(s => s.loadAfter)
  const loadLatest = useStore(s => s.loadLatest)
  const setReplyTo = useStore(s => s.setReplyTo)
  const jumpToMessage = useStore(s => s.jumpToMessage)
  const me = useStore(s => s.me)
  const highlight = useStore(s => s.highlight)
  const clearHighlight = useStore(s => s.clearHighlight)
  const thinks = useStore(s => s.thinks)
  const clearThink = useStore(s => s.clearThink)
  const boxRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)
  const [showJump, setShowJump] = useState(false)
  useLang()

  // 右下角箭头：跳回最新一条消息（看旧段时 = 直达最后一段）
  const jumpToBottom = () => {
    const box = boxRef.current
    if (!box) return
    stickBottom.current = true
    scrollState.atBottom = true
    setShowJump(false)
    if (moreAfter && activeConvId) loadLatest(activeConvId)   // 完成后 scrollSignal 强制贴底
    else box.scrollTop = box.scrollHeight
  }

  // 跳转定位高亮：6 秒后自动消退
  useEffect(() => {
    if (!highlight) return
    const t = setTimeout(() => clearHighlight(), 6000)
    return () => clearTimeout(t)
  }, [highlight, clearHighlight])

  const msgs = activeConvId ? messages[activeConvId] || [] : []
  const more = activeConvId ? hasMore[activeConvId] : false
  const moreAfter = activeConvId ? hasMoreAfter[activeConvId] : false

  const scrollSignal = useStore(s => s.scrollSignal)

  // 新消息时保持贴底——仅当窗口已到会话最末尾（无更晚段）时；
  // 正在读旧段时向下翻段追加内容不钉底，让用户自然续读，避免跳过整段
  useEffect(() => {
    const box = boxRef.current
    if (box && stickBottom.current && !moreAfter) box.scrollTop = box.scrollHeight
  }, [msgs.length, moreAfter])

  // 进入 / 点击会话：贴底；历史查询跳转（有 highlight）：定位到目标消息居中——
  // 居中不在底缘，也避免了贴底动作立刻误触发"向下翻段"
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const hl = highlight?.convId === activeConvId ? highlight : null
    const el = hl ? document.getElementById(`msg-${hl.seq}`) : null
    if (el) {
      el.scrollIntoView({ block: 'center' })
      stickBottom.current = false
      scrollState.atBottom = false
      useStore.getState().setMsgAtBottom(false)
    } else {
      stickBottom.current = true
      scrollState.atBottom = true
      useStore.getState().setMsgAtBottom(true)
      setShowJump(false)
      box.scrollTop = box.scrollHeight
    }
  }, [activeConvId, scrollSignal])

  const onScroll = async () => {
    const box = boxRef.current
    if (!box) return
    stickBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 60
    scrollState.atBottom = stickBottom.current
    setShowJump(!stickBottom.current)
    useStore.getState().setMsgAtBottom(stickBottom.current)
    if (box.scrollTop < 50 && more && !loadingHistory && activeConvId) {
      const oldHeight = box.scrollHeight
      await loadHistory(activeConvId)
      requestAnimationFrame(() => {
        box.scrollTop = box.scrollHeight - oldHeight + box.scrollTop
      })
    }
    // 贴着窗口底向下翻：动态加载下一段（追加在下方，视口不动，自然向下续读）
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 60
        && moreAfter && !loadingHistory && activeConvId) {
      loadAfter(activeConvId)
    }
  }

  // 引用块点击 → 定位原消息：在当前窗口内直接滚动+高亮，否则按 seq 跳段加载
  const jumpToReply = (seq: number) => {
    if (!activeConvId) return
    const el = document.getElementById(`msg-${seq}`)
    if (el) {
      useStore.setState({ highlight: { convId: activeConvId, seq } })
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } else {
      jumpToMessage(activeConvId, seq)
    }
  }

  // 稳定回调（配合 MessageRow 的 memo）：think 心跳/无关会话更新时
  // 消息子树不重渲染——内联 <audio> 播放不中断、媒体缩略不闪烁
  const onReplyStable = useCallback((m: Msg) => setReplyTo(m), [setReplyTo])
  const onJumpReplyStable = useCallback((m: Msg) => {
    if (m.reply_to) jumpToReply(m.reply_to.seq)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvId, jumpToMessage])

  if (!activeConvId) {
    return <div ref={boxRef} style={{ flex: 1, display: 'flex',
      alignItems: 'center', justifyContent: 'center', color: '#999' }}>
      {tt('chat.emptyHint')}
    </div>
  }

  return (
    <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
      <div ref={boxRef} onScroll={onScroll}
           style={{ height: '100%', overflowY: 'auto', padding: '12px 16px' }}>
        {more && <div style={{ textAlign: 'center', color: '#999', fontSize: 12,
                               padding: 4 }}>{tt('chat.loadMoreUp')}</div>}
        {msgs.map(m => m.type === 'system'
          ? <div key={m.id} style={{ textAlign: 'center', color: '#999',
                                     fontSize: 12, margin: '8px 0' }}>
              {m.content} · {m.sender}
            </div>
          : <MessageRow key={m.id} m={m} me={me?.username || ''}
                        highlighted={highlight?.convId === activeConvId
                                     && highlight.seq === m.seq}
                        onReply={onReplyStable}
                        onJumpReply={onJumpReplyStable} />)}
        {Object.entries(thinks[activeConvId] || {}).map(([sender, t]) => (
          <ThinkBubble key={sender} t={t}
                       onClose={() => clearThink(activeConvId, sender)} />
        ))}
        {moreAfter && <div style={{ textAlign: 'center', color: '#999', fontSize: 12,
                                    padding: 4 }}>{tt('chat.loadMoreDown')}</div>}
      </div>
      {showJump && (
        <Tooltip title={tt('chat.jumpLatest')} placement="left">
          <Button shape="circle" size="large" icon={<DownOutlined />}
                  onClick={jumpToBottom}
                  style={{ position: 'absolute', right: 16, bottom: 16,
                           boxShadow: '0 2px 8px rgba(0,0,0,0.18)' }} />
        </Tooltip>
      )}
    </div>
  )
}

// memo + 稳定回调：think 心跳等无关更新不重渲染消息子树（内联 audio 不中断）
const MessageRow = memo(function MessageRow({ m, me, highlighted, onReply, onJumpReply }: {
  m: Msg; me: string; highlighted?: boolean;
  onReply: (m: Msg) => void; onJumpReply: (m: Msg) => void }) {
  // hook 必须在组件顶层（不能写在下面 JSX 的属性里——map 循环渲染会违反
  // hooks 规则触发 React #310 白屏）
  const isMobile = useIsMobile()
  const mine = m.sender === me
  const mentionedMe = m.mentions.includes(me) || m.mentions.includes('all')
  const toggle = async (emoji: string) => {
    const { addReaction, removeReaction } = await import('../api')
    const r = m.reactions.find(x => x.emoji === emoji)
    try {
      if (r?.users.includes(me)) await removeReaction(m.id, emoji)
      else await addReaction(m.id, emoji)
    } catch (e: any) { console.error(e.message) }
  }

  return (
    <div id={`msg-${m.seq}`}
         style={{ display: 'flex', flexDirection: mine ? 'row-reverse' : 'row',
                  margin: '10px 0', gap: 8,
                  outline: highlighted ? '2px solid #ffd666' : undefined,
                  outlineOffset: 2, borderRadius: 8,
                  padding: highlighted ? 4 : undefined,
                  transition: 'outline 0.3s' }}>
      <UserProfileCard username={m.sender}>
        <Avatar style={{ background: convColor(m.sender), flexShrink: 0 }}>
          {m.sender[0].toUpperCase()}
        </Avatar>
      </UserProfileCard>
      <div style={{ maxWidth: isMobile ? '86%' : '68%' }}>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 2,
                      textAlign: mine ? 'right' : 'left' }}>
          {m.sender} · {msgTime(m.created_at)}
          {!!m.codec && <span title={tt('msg.encrypted')}> 🔒</span>}
        </div>
        <div style={{
          background: mentionedMe ? '#fff7e6' : (mine ? '#e6f4ff' : '#fff'),
          border: mentionedMe ? '1px solid #ffd591' : '1px solid #f0f0f0',
          borderRadius: 8, padding: '8px 12px',
          wordBreak: 'break-word', overflowWrap: 'anywhere',
        }}>
          {m.reply_to && (
            <div onClick={() => onJumpReply(m)} title={tt('msg.jumpToOriginal')}
                 style={{ fontSize: 12, color: '#888', borderLeft: '2px solid #bbb',
                          paddingLeft: 6, marginBottom: 6, cursor: 'pointer' }}>
              <b>{m.reply_to.sender}</b>：{m.reply_to.excerpt}
            </div>
          )}
          <Markdown content={m.content} />
        </div>
        {m.reactions.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginTop: 3,
                        justifyContent: mine ? 'flex-end' : 'flex-start' }}>
            {m.reactions.map(r => (
              <span key={r.emoji} onClick={() => toggle(r.emoji)}
                    style={{ cursor: 'pointer', background: '#f5f5f5', borderRadius: 10,
                             padding: '1px 7px', fontSize: 12,
                             border: r.users.includes(me) ? '1px solid #91caff' : '1px solid transparent' }}>
                {r.emoji} {r.users.length}
              </span>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 2, marginTop: 2, opacity: 0.15,
                      justifyContent: mine ? 'flex-end' : 'flex-start' }}
             className="msg-actions">
          <Tooltip title={tt('msg.replyBtnTitle')}>
            <Button type="text" size="small" onClick={() => onReply(m)}
                    style={{ fontSize: 12 }}>{tt('msg.replyBtn')}</Button>
          </Tooltip>
          {QUICK_EMOJIS.map(e => (
            <Button key={e} type="text" size="small" onClick={() => toggle(e)}>
              {e}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
})

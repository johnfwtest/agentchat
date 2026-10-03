import { useCallback, useEffect, useRef, useState } from 'react'
import { Avatar, Badge, Button, DatePicker, Drawer, Input, Popconfirm,
         Select, Space, Table, Tag, message } from 'antd'
import { ArrowLeftOutlined, ReloadOutlined, TeamOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import { AdminGroup, ConvItem, Msg, UserItem,
         adminDissolveGroup, adminFetchMessages, adminGroupDetail,
         adminListGroups, fetchUsers } from '../api'
import { convColor } from '../components/ConvList'
import { t as T, useLang } from '../i18n'
import { msgTime } from '../time'
import Markdown from '../components/Markdown'
import UserProfileCard from '../components/UserProfileCard'

/** 管理员只读群消息面板：消息列表（前翻/跳转最后）+ 群信息/成员，无输入框。
 * 独立页面（非聊天页），管理员不出现在群成员里。 */
export default function AdminGroupPanel({ convId, initialSeq, onBack }: {
  convId: string; initialSeq?: number | null; onBack: () => void }) {
  const [conv, setConv] = useState<ConvItem | null>(null)
  const [users, setUsers] = useState<UserItem[]>([])
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)
  const [showJump, setShowJump] = useState(false)
  useLang()
  const [highlightRaw, setHighlight] = useState<number | null>(initialSeq ?? null)
  // 归一化：恒以 number 比较（上游跳转载荷类型漂移时 === 会静默失配）
  const highlight = highlightRaw != null ? Number(highlightRaw) : null

  const loadLatest = useCallback(async () => {
    // initialSeq（历史查询跳转）：seq 分段寻址直接落到该消息所在段，
    // 渲染后定位居中 + 高亮；无则最新段贴底
    const r = initialSeq
      ? await adminFetchMessages(convId, { seq: initialSeq })
      : await adminFetchMessages(convId, {})
    stickBottom.current = !initialSeq
    setHighlight(initialSeq ?? null)
    setMsgs(r.messages); setHasMore(r.has_more)
  }, [convId, initialSeq])

  useEffect(() => {
    adminGroupDetail(convId).then(setConv).catch(() => {})
    fetchUsers().then(r => setUsers(r.users)).catch(() => {})
    loadLatest()
  }, [convId, loadLatest])

  // msgs 渲染完成后：定位模式滚动目标消息居中；贴底模式滚到底
  // （比单个 rAF 可靠：覆盖 Markdown/媒体渲染导致的高度变化）
  useEffect(() => {
    const b = boxRef.current
    if (!b) return
    if (highlight != null) {
      const el = document.getElementById(`msg-${highlight}`)
      if (el) el.scrollIntoView({ block: 'center' })
    } else if (stickBottom.current) {
      b.scrollTop = b.scrollHeight
    }
  }, [msgs])

  const loadOlder = async () => {
    if (loadingMore || !msgs.length) return
    setLoadingMore(true)
    try {
      const b = boxRef.current
      const oldH = b ? b.scrollHeight : 0
      const r = await adminFetchMessages(convId, { before_seq: msgs[0].seq })
      const seen = new Set<number>()
      const merged = [...r.messages, ...msgs]
        .filter(m => !seen.has(m.seq) && seen.add(m.seq))
        .sort((a, b) => a.seq - b.seq)
      setMsgs(merged); setHasMore(r.has_more)
      requestAnimationFrame(() => {
        if (b) b.scrollTop = b.scrollHeight - oldH + b.scrollTop
      })
    } finally { setLoadingMore(false) }
  }

  // 跳转定位高亮：6 秒后自动消退
  useEffect(() => {
    if (highlight == null) return
    const t = setTimeout(() => setHighlight(null), 6000)
    return () => clearTimeout(t)
  }, [highlight])

  const onScroll = () => {
    const b = boxRef.current
    if (!b) return
    const atBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 60
    stickBottom.current = atBottom
    setShowJump(!atBottom)                // 离开底部即显示"跳转到最后"
    if (b.scrollTop < 50 && hasMore && !loadingMore) loadOlder()
  }

  const title = conv?.name || T('conv.group')
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 52, flexShrink: 0, display: 'flex', alignItems: 'center',
                    gap: 8, padding: '0 12px', borderBottom: '1px solid #f0f0f0',
                    background: '#fff' }}>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack}
                title={T('admin.groups.backToGroups')} />
        <Avatar shape="square" style={{ background: convColor(title) }}>
          {title[0]?.toUpperCase()}
        </Avatar>
        <b style={{ fontSize: 15 }}>{title}</b>
        <Tag style={{ marginLeft: 4 }}>{T('admin.groups.readonlyTag')}</Tag>
        <Button type="text" size="small" icon={<TeamOutlined />}
                style={{ marginLeft: 'auto' }}
                onClick={() => setInfoOpen(true)}>
          {T('chat.groupInfo')}（{conv?.members.length ?? '—'}）
        </Button>
      </div>

      {/* 内嵌消息框（独立滚动条）：默认加载最新一段并贴底，上翻流式加载更早
          的一段——消息再多也只渲染当前窗口（与用户聊天页同款分段模式） */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0, padding: '10px 14px',
                    background: '#f5f6f8' }}>
        <div ref={boxRef} onScroll={onScroll}
             style={{ height: '100%', overflowY: 'auto', padding: '12px 16px',
                      background: '#fff', border: '1px solid #f0f0f0',
                      borderRadius: 8 }}>
          {hasMore && <div style={{ textAlign: 'center', color: '#999', fontSize: 12,
                                    padding: 4 }}>
            {loadingMore ? T('admin.groups.loading') : T('admin.groups.loadOlder')}
          </div>}
          {msgs.map(m => m.type === 'system'
            ? <div key={m.id} style={{ textAlign: 'center', color: '#999',
                                       fontSize: 12, margin: '8px 0' }}>
                {m.content} · {m.sender}
              </div>
            : <div key={m.id} id={`msg-${m.seq}`}
                   style={{ display: 'flex', margin: '10px 0', gap: 8,
                            outline: highlight === m.seq ? '2px solid #ffd666' : undefined,
                            outlineOffset: 2, borderRadius: 8,
                            padding: highlight === m.seq ? 4 : undefined,
                            transition: 'outline 0.3s' }}>
                <UserProfileCard username={m.sender}>
                  <Avatar style={{ background: convColor(m.sender), flexShrink: 0 }}>
                    {m.sender[0]?.toUpperCase()}
                  </Avatar>
                </UserProfileCard>
                <div style={{ maxWidth: '68%' }}>
                  <div style={{ fontSize: 12, color: '#999', marginBottom: 2 }}>
                    {m.sender} · {msgTime(m.created_at)} · seq {m.seq}
                  </div>
                  <div style={{ background: '#fff', border: '1px solid #f0f0f0',
                                borderRadius: 8, padding: '8px 12px',
                                wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                    {m.reply_to && (
                      <div style={{ fontSize: 12, color: '#888',
                                    borderLeft: '2px solid #bbb', paddingLeft: 6,
                                    marginBottom: 6 }}>
                        <b>{m.reply_to.sender}</b>：{m.reply_to.excerpt}
                      </div>
                    )}
                    <Markdown content={m.content} />
                  </div>
                  {m.reactions.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
                      {m.reactions.map(r => (
                        <span key={r.emoji}
                              style={{ background: '#f5f5f5', borderRadius: 10,
                                       padding: '1px 7px', fontSize: 12 }}>
                          {r.emoji} {r.users.length}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>)}
          {!msgs.length && !hasMore && (
            <div style={{ textAlign: 'center', color: '#999', padding: 40 }}>
              {T('admin.groups.noMessages')}
            </div>
          )}
        </div>
        {showJump && (
          <Button shape="circle" icon={<ArrowLeftOutlined rotate={90} />}
                  onClick={loadLatest}
                  title={T('admin.groups.jumpLatest')}
                  style={{ position: 'absolute', right: 16, bottom: 16,
                           boxShadow: '0 2px 8px rgba(0,0,0,0.18)' }} />
        )}
      </div>

      <Drawer title={T('admin.groups.groupInfoTitle').replace('{name}', title)} open={infoOpen} width={320}
              onClose={() => setInfoOpen(false)}>
        <div style={{ marginBottom: 10 }}>{T('admin.groups.groupName')}：<b>{conv?.name}</b></div>
        <div style={{ marginBottom: 10 }}>{T('admin.groups.owner')}：<b>{conv?.owner}</b></div>
        <div style={{ marginBottom: 16, whiteSpace: 'pre-wrap' }}>
          {T('admin.groups.descLabel')}：{conv?.desc || <span style={{ color: '#bbb' }}>{T('admin.groups.descNone')}</span>}
        </div>
        <div style={{ marginBottom: 8 }}>{T('group.members')}（{conv?.members.length}）</div>
        {conv?.members.map(u => {
          const online = users.find(x => x.username === u)?.online
          return (
            <div key={u} style={{ display: 'flex', alignItems: 'center', gap: 8,
                                  padding: '6px 0' }}>
              <Badge dot status={online ? 'success' : 'default'}
                     title={online ? T('common.online') : T('common.offline')}>
                <Avatar style={{ background: convColor(u) }}>{u[0]?.toUpperCase()}</Avatar>
              </Badge>
              <span>{u === conv.owner ? <b>{u}</b> : u}</span>
              {u === conv.owner && <Tag color="gold">{T('group.owner')}</Tag>}
            </div>
          )
        })}
      </Drawer>
    </div>
  )
}

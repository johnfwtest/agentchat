import { useMemo, useState } from 'react'
import { Avatar, Badge, Button, List, Popconfirm, Tooltip, theme } from 'antd'
import { TeamOutlined, MessageOutlined } from '@ant-design/icons'
import { ConvItem } from '../api'
import { useStore, getReadSeq, hasMentionUnread } from '../store'

export const convColor = (name: string) => {
  const colors = ['#f56a00', '#7265e6', '#ffbf00', '#00a2ae',
                  '#87d068', '#f50', '#2db7f5', '#eb2f96']
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return colors[h % colors.length]
}

export function renderTime(at?: string | null) {
  if (!at) return ''
  const d = new Date(at)
  const today = new Date()
  if (d.toDateString() === today.toDateString())
    return d.toTimeString().slice(0, 5)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export default function ConvList({ onOpenDirectory, onCreateGroup }: {
  onOpenDirectory: () => void
  onCreateGroup: () => void
}) {
  const convs = useStore(s => s.convs)
  const activeId = useStore(s => s.activeConvId)
  const openConv = useStore(s => s.openConv)
  const me = useStore(s => s.me)
  const users = useStore(s => s.users)
  const readVersion = useStore(s => s.readVersion)   // 未读变化时重算红点
  const { token } = theme.useToken()

  const sorted = useMemo(() =>
    [...convs].sort((a, b) =>
      (b.last_msg?.at || '').localeCompare(a.last_msg?.at || '')), [convs])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '12px 12px 4px', display: 'flex', gap: 8 }}>
        <Button block icon={<MessageOutlined />} onClick={onOpenDirectory}>
          通讯录
        </Button>
        <Button block icon={<TeamOutlined />} onClick={onCreateGroup}>
          建群
        </Button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <List
          dataSource={sorted}
          renderItem={(c: ConvItem) => {
            const unread = Math.max(0, c.last_seq - getReadSeq(c.id))
            const mentioned = hasMentionUnread(c.id)
            const title = c.type === 'group' ? (c.name || '群聊')
              : c.members.filter(m => m !== me?.username)[0] || c.id
            // 私聊头像右下角在线小点（与通讯录一致）；群聊不加
            const peerOnline = c.type === 'private'
              ? users.find(u => u.username === title)?.online : undefined
            return (
              <List.Item onClick={() => openConv(c.id)}
                style={{ cursor: 'pointer', padding: '10px 14px',
                         background: activeId === c.id ? token.colorFillSecondary : undefined,
                         borderLeft: mentioned ? '3px solid #f5222d' : '3px solid transparent' }}>
                <List.Item.Meta
                  avatar={
                    <Badge count={unread} size="small" offset={[-4, 28]}
                           color={mentioned ? '#f5222d' : undefined}>
                      {/* 群聊方型头像，私聊圆形 */}
                      {(() => {
                        const av = (
                          <Avatar shape={c.type === 'group' ? 'square' : 'circle'}
                                  style={{ background: convColor(title) }}>
                            {title[0]?.toUpperCase()}
                          </Avatar>
                        )
                        return peerOnline === undefined ? av : (
                          <Badge dot status={peerOnline ? 'success' : 'default'}
                                 offset={[-4, 30]}
                                 title={peerOnline ? '在线' : '离线'}>
                            {av}
                          </Badge>
                        )
                      })()}
                    </Badge>
                  }
                  title={<span style={{ fontSize: 14 }}>{title}</span>}
                  description={
                    <div style={{ fontSize: 12, whiteSpace: 'nowrap',
                                  overflow: 'hidden', textOverflow: 'ellipsis',
                                  maxWidth: 170 }}>
                      {c.last_msg
                        ? `${c.last_msg.sender === me?.username ? '我' : c.last_msg.sender}: ${c.last_msg.preview}`
                        : '暂无消息'}
                    </div>
                  }
                />
                <span style={{ fontSize: 11, color: token.colorTextTertiary }}>
                  {renderTime(c.last_msg?.at)}
                </span>
              </List.Item>
            )
          }}
        />
      </div>
    </div>
  )
}

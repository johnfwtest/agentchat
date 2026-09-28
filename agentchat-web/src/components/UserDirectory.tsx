import { useEffect, useState } from 'react'
import { Avatar, Badge, Input, List, Modal, Tabs, Tag, message } from 'antd'
import { TeamOutlined } from '@ant-design/icons'
import { ConvItem, UserItem, createPrivate, fetchUsers } from '../api'
import { useStore } from '../store'
import { convColor } from './ConvList'
import { useIsMobile } from '../responsive'
import UserProfileCard from './UserProfileCard'

export default function UserDirectory({ open, onClose }: {
  open: boolean
  onClose: () => void
}) {
  const me = useStore(s => s.me)
  const convs = useStore(s => s.convs)
  const openConv = useStore(s => s.openConv)
  const loadConvs = useStore(s => s.loadConvs)
  const [users, setUsers] = useState<UserItem[]>([])
  const [filter, setFilter] = useState('')
  const [userPage, setUserPage] = useState(1)
  const [groupPage, setGroupPage] = useState(1)
  const isMobile = useIsMobile()

  useEffect(() => {
    if (open) {
      fetchUsers().then(r => setUsers(r.users)).catch(() => {})
      loadConvs()
      setUserPage(1); setGroupPage(1)
    }
  }, [open])

  const startChat = async (u: string) => {
    try {
      const conv = await createPrivate(u)
      await loadConvs()
      onClose()
      openConv(conv.id)
    } catch (e: any) {
      message.error(e.message)
    }
  }

  const filteredUsers = users.filter(u =>
    u.username.includes(filter) && u.username !== me?.username)
  const myGroups = convs
    .filter(c => c.type === 'group' && (c.name || '').includes(filter))
    .sort((a, b) =>
      (b.last_msg?.at || '').localeCompare(a.last_msg?.at || ''))

  const listBody = (children: React.ReactNode) => (
    <>
      <Input.Search placeholder="搜索用户名 / 群名" value={filter}
                    onChange={e => { setFilter(e.target.value)
                                     setUserPage(1); setGroupPage(1) }}
                    style={{ marginBottom: 12 }} allowClear />
      <div style={{ maxHeight: 380, overflowY: 'auto' }}>{children}</div>
    </>
  )

  return (
    <Modal title="通讯录" open={open} onCancel={onClose}
           footer={null} width={isMobile ? '100%' : 420}>
      <Tabs defaultActiveKey="private"
            items={[
              {
                key: 'private',
                label: '私聊',
                children: listBody(
                  <List
                    dataSource={filteredUsers}
                    pagination={{ pageSize: 10, size: 'small', current: userPage,
                                  onChange: setUserPage,
                                  showTotal: t => `共 ${t} 人` }}
                    locale={{ emptyText: '暂无其他用户' }}
                    renderItem={u => (
                      <List.Item style={{ cursor: 'pointer', padding: '8px 4px' }}
                                 onClick={() => startChat(u.username)}>
                        <List.Item.Meta
                          avatar={
                            <Badge dot status={u.online ? 'success' : 'default'}
                                   offset={[-4, 30]}>
                              <UserProfileCard username={u.username}>
                                <Avatar style={{ background: convColor(u.username) }}>
                                  {u.username[0].toUpperCase()}
                                </Avatar>
                              </UserProfileCard>
                            </Badge>
                          }
                          title={<span>
                            {u.username}
                            {u.role === 'admin' && (
                              <Tag color="blue" style={{ marginLeft: 6 }}>admin</Tag>
                            )}
                            {u.disabled && <Tag color="red" style={{ marginLeft: 6 }}>禁用</Tag>}
                          </span>}
                          description={u.online ? '在线' : '离线'}
                        />
                      </List.Item>
                    )}
                  />),
              },
              {
                key: 'group',
                label: '群聊',
                children: listBody(
                  <List
                    dataSource={myGroups}
                    pagination={{ pageSize: 10, size: 'small', current: groupPage,
                                  onChange: setGroupPage,
                                  showTotal: t => `共 ${t} 个群` }}
                    locale={{ emptyText: '还没有群聊，点左上角「建群」创建' }}
                    renderItem={(g: ConvItem) => (
                      <List.Item style={{ cursor: 'pointer', padding: '8px 4px' }}
                                 onClick={() => { onClose(); openConv(g.id) }}>
                        <List.Item.Meta
                          avatar={
                            <Avatar style={{ background: convColor(g.name || '群') }}
                                    icon={<TeamOutlined />}>
                            </Avatar>
                          }
                          title={g.name || '群聊'}
                          description={`${g.members.length} 人 · 群主 ${g.owner}`}
                        />
                      </List.Item>
                    )}
                  />),
              },
            ]} />
    </Modal>
  )
}

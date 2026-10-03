import { useState } from 'react'
import { Avatar, Badge, Button, Drawer, Input, List, Modal, Popconfirm,
         Select, Space, Tag, message } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'
import { ConvItem, addMember, dissolveGroup, fetchUsers, removeMember,
         renameGroup, updateGroup } from '../api'
import { useStore } from '../store'
import { convColor } from './ConvList'
import { useIsMobile } from '../responsive'
import { t as T, useLang } from '../i18n'
import UserProfileCard from './UserProfileCard'

export default function GroupInfo({ open, conv, onClose }: {
  open: boolean
  conv: ConvItem | null
  onClose: () => void
}) {
  const me = useStore(s => s.me)
  const users = useStore(s => s.users)
  const loadConvs = useStore(s => s.loadConvs)
  const setActive = useStore(s => s.setActive)
  const [addOpen, setAddOpen] = useState(false)
  const [addName, setAddName] = useState<string | undefined>()
  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState('')
  const [descEditing, setDescEditing] = useState(false)
  const [newDesc, setNewDesc] = useState('')
  const [candidates, setCandidates] = useState<string[]>([])
  // hook 必须在下方早退（return null）之前调用：私聊时早退、群聊时不退，
  // hook 写在 JSX 里会导致两次渲染 hook 数不同 → React #310 白屏
  const isMobile = useIsMobile()
  useLang()

  if (!conv || conv.type !== 'group') return null
  const isOwner = conv.owner === me?.username

  const openAdd = async () => {
    try {
      const r = await fetchUsers()
      setCandidates(r.users
        .filter(u => !conv.members.includes(u.username) && !u.disabled)
        .map(u => u.username))
      setAddOpen(true)
    } catch (e: any) { message.error(e.message) }
  }

  const doAdd = async () => {
    if (!addName) return
    try {
      await addMember(conv.id, addName)
      message.success(T('group.invitedOk').replace('{name}', String(addName)))
      setAddOpen(false); setAddName(undefined)
      await loadConvs()
    } catch (e: any) { message.error(e.message) }
  }

  const doRemove = async (username: string) => {
    try {
      await removeMember(conv.id, username)
      message.success(T('group.removedOk').replace('{name}', String(username)))
      await loadConvs()
    } catch (e: any) { message.error(e.message) }
  }

  const doRename = async () => {
    if (!newName.trim()) return
    try {
      await renameGroup(conv.id, newName.trim())
      message.success(T('group.renamedOk'))
      setRenaming(false)
      await loadConvs()
    } catch (e: any) { message.error(e.message) }
  }

  const doDesc = async () => {
    try {
      await updateGroup(conv.id, { desc: newDesc.trim() })
      message.success(T('group.descUpdated'))
      setDescEditing(false)
      await loadConvs()
    } catch (e: any) { message.error(e.message) }
  }

  const doDissolve = async () => {
    try {
      await dissolveGroup(conv.id)
      message.success(T('group.dissolve'))
      onClose()
      setActive(null)
      await loadConvs()
    } catch (e: any) { message.error(e.message) }
  }

  return (
    <Drawer title={conv.name || T('conv.group')} open={open} onClose={onClose}
             width={isMobile ? '100%' : 320}>
      {renaming ? (
        <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
          <Input value={newName} onChange={e => setNewName(e.target.value)}
                 placeholder={T('group.newName')} onPressEnter={doRename} autoFocus />
          <Button type="primary" onClick={doRename}>{T('common.save')}</Button>
          <Button onClick={() => setRenaming(false)}>{T('common.cancel')}</Button>
        </Space.Compact>
      ) : (
        <div style={{ marginBottom: 16 }}>
          {''}{T('group.name')}：<b>{conv.name}</b>
          {isOwner && (
            <Button type="link" size="small" onClick={() => {
              setNewName(conv.name || ''); setRenaming(true)
            }}>{T('group.rename')}</Button>
          )}
        </div>
      )}

      {descEditing ? (
        <div style={{ marginBottom: 16 }}>
          <Input.TextArea rows={2} maxLength={200} showCount value={newDesc}
                          placeholder={T('group.descPlaceholder')} autoFocus
                          onChange={e => setNewDesc(e.target.value)} />
          <div style={{ marginTop: 6, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button size="small" onClick={() => setDescEditing(false)}>{T('common.cancel')}</Button>
            <Button size="small" type="primary" onClick={doDesc}>{T('common.save')}</Button>
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: 16, whiteSpace: 'pre-wrap' }}>
          {T('group.desc')}：<span style={{ color: conv.desc ? '#333' : '#bbb' }}>{conv.desc || T('group.descNone')}</span>
          {isOwner && (
            <Button type="link" size="small" onClick={() => {
              setNewDesc(conv.desc || ''); setDescEditing(true)
            }}>{T('group.editDesc')}</Button>
          )}
        </div>
      )}

      <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
        <span>{T('group.members')}（{conv.members.length}）</span>
        <Button type="link" size="small" onClick={openAdd}>{T('group.invite')}</Button>
      </div>
      <List
        dataSource={conv.members}
        renderItem={u => (
          <List.Item
            actions={isOwner && u !== conv.owner ? [
              <Popconfirm key="del" title={T('group.confirmRemove').replace('{name}', u)} onConfirm={() => doRemove(u)}>
                <Button type="text" danger size="small"
                        icon={<DeleteOutlined />} />
              </Popconfirm>,
            ] : undefined}
          >
            <List.Item.Meta
              avatar={
                <Badge dot status={users.find(x => x.username === u)?.online
                                  ? 'success' : 'default'}
                       offset={[-4, 30]}
                       title={users.find(x => x.username === u)?.online ? T('common.online') : T('common.offline')}>
                  <UserProfileCard username={u}>
                    <Avatar style={{ background: convColor(u) }}>
                      {u[0].toUpperCase()}
                    </Avatar>
                  </UserProfileCard>
                </Badge>
              }
              title={<span>
                {u === me?.username ? `${u}${T('group.me')}` : u}
                {u === conv.owner && (
                  <Tag color="gold" style={{ marginLeft: 6 }}>{T('group.owner')}</Tag>
                )}
              </span>}
            />
          </List.Item>
        )}
      />

      {isOwner && (
        <div style={{ marginTop: 24 }}>
          <Popconfirm title={T('group.confirmDissolve')} onConfirm={doDissolve}>
            <Button danger block>{T('group.dissolve')}</Button>
          </Popconfirm>
        </div>
      )}

      <Modal title={T('group.inviteTitle')} open={addOpen} onOk={doAdd}
             onCancel={() => setAddOpen(false)} okText={T('group.inviteTitle')} cancelText={T('common.cancel')}>
        <Select style={{ width: '100%' }} value={addName} onChange={setAddName}
                placeholder={T('group.selectUser')} options={candidates.map(c => ({ value: c, label: c }))} />
      </Modal>
    </Drawer>
  )
}

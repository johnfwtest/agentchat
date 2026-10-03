import { useEffect, useState } from 'react'
import { Avatar, Button, Input, Popover, Select, Tag, message } from 'antd'
import { createPrivate, fetchUserProfile, updateUserProfile } from '../api'
import { UserProfile } from '../api'
import { useStore } from '../store'
import { convColor } from './ConvList'
import { t as T, useLang } from '../i18n'

/** 点击头像弹出的用户 Profile 卡片：tags + 个性签名；本人/管理员可编辑。 */
export default function UserProfileCard({ username, children }: {
  username: string
  children: React.ReactNode
}) {
  const me = useStore(s => s.me)
  const openConv = useStore(s => s.openConv)
  const loadConvs = useStore(s => s.loadConvs)
  const [open, setOpen] = useState(false)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [editing, setEditing] = useState(false)
  const [tagDraft, setTagDraft] = useState<string[]>([])
  const [bioDraft, setBioDraft] = useState('')
  const [saving, setSaving] = useState(false)
  useLang()

  // username 变化时必须清空（组件实例复用场景：私聊顶栏切换会话，React 复用
  // 本组件但 state 不重置——曾致显示上一个用户的 tags/bio）；每次打开都重新
  // 拉取（顺带解决数据被别处更新后的陈旧问题）
  useEffect(() => {
    setProfile(null); setEditing(false); setOpen(false)
  }, [username])

  const canEdit = me?.username === username || me?.role === 'admin'

  const load = async () => {
    try { setProfile(await fetchUserProfile(username)) }
    catch { /* 打开失败保持空 */ }
  }

  const startEdit = () => {
    setTagDraft(profile?.tags || [])
    setBioDraft(profile?.bio || '')
    setEditing(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      setProfile(await updateUserProfile(username, { tags: tagDraft, bio: bioDraft }))
      setEditing(false)
      message.success(T('profile.saved'))
    } catch (e: any) { message.error(e.message) }
    finally { setSaving(false) }
  }

  const startChat = async () => {
    try {
      const conv = await createPrivate(username)
      await loadConvs()
      openConv(conv.id)
    } catch (e: any) { message.error(e.message) }
  }

  const content = (
    <div style={{ width: 264 }} onClick={e => e.stopPropagation()}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <Avatar size={44} style={{ background: convColor(username) }}>
          {username[0].toUpperCase()}
        </Avatar>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>
            {username}
            {profile?.role === 'admin' && (
              <Tag color="blue" style={{ marginLeft: 6 }}>admin</Tag>
            )}
          </div>
          {profile?.created_at && (
            <div style={{ fontSize: 12, color: '#999' }}>
              {T('profile.joinedAt')} {(profile.created_at || '').slice(0, 10)}
            </div>
          )}
        </div>
        {me?.username !== username && (
          <Button size="small" onClick={startChat}>{T('profile.chat')}</Button>
        )}
      </div>

      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>{T('profile.tags')}</div>
            <Select mode="tags" value={tagDraft} onChange={setTagDraft} open={false}
                    placeholder={T('profile.tagsPlaceholder')} tokenSeparators={[',']}
                    style={{ width: '100%' }} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>{T('profile.bio')}</div>
            <Input.TextArea rows={2} maxLength={200} showCount value={bioDraft}
                            placeholder={T('profile.bioPlaceholder')} onChange={e => setBioDraft(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button size="small" onClick={() => setEditing(false)}>{T('common.cancel')}</Button>
            <Button size="small" type="primary" loading={saving} onClick={save}>{T('common.save')}</Button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minHeight: 22 }}>
            {profile?.tags?.length
              ? profile.tags.map(t => <Tag key={t} color="geekblue">{t}</Tag>)
              : <span style={{ fontSize: 12, color: '#bbb' }}>{T('profile.noTags')}</span>}
          </div>
          <div style={{ fontSize: 13, color: '#555', marginTop: 6,
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {profile?.bio || <span style={{ color: '#bbb' }}>{T('profile.noBio')}</span>}
          </div>
          {canEdit && (
            <Button size="small" type="link" style={{ marginTop: 6, padding: 0, height: 'auto' }}
                    onClick={startEdit}>{T('profile.edit')}</Button>
          )}
        </>
      )}
    </div>
  )

  return (
    <Popover content={content} trigger="click" placement="right"
             open={open}
             onOpenChange={v => { setOpen(v); if (v) load() }}>
      <span onClick={e => e.stopPropagation()}
            style={{ cursor: 'pointer', display: 'inline-flex' }}>{children}</span>
    </Popover>
  )
}

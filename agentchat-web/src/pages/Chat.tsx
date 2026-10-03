import { useEffect, useMemo, useState } from 'react'
import { Avatar, Badge, Button, Layout, Modal, Input, message } from 'antd'
import { ArrowLeftOutlined, LogoutOutlined, TeamOutlined } from '@ant-design/icons'
import { ConvItem, createGroup, fetchUsers } from '../api'
import { useStore } from '../store'
import { useIsMobile } from '../responsive'
import { t, useLang } from '../i18n'
import { convColor } from '../components/ConvList'
import ConvList from '../components/ConvList'
import MessageList from '../components/MessageList'
import Composer from '../components/Composer'
import GroupInfo from '../components/GroupInfo'
import UserDirectory from '../components/UserDirectory'
import UserProfileCard from '../components/UserProfileCard'

const { Sider, Content } = Layout

export default function Chat() {
  const me = useStore(s => s.me)
  const convs = useStore(s => s.convs)
  const users = useStore(s => s.users)
  const activeConvId = useStore(s => s.activeConvId)
  const logout = useStore(s => s.logout)
  const loadConvs = useStore(s => s.loadConvs)
  const openConv = useStore(s => s.openConv)
  const msgAtBottom = useStore(s => s.msgAtBottom)

  const [dirOpen, setDirOpen] = useState(false)
  const [groupInfoOpen, setGroupInfoOpen] = useState(false)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupMembers, setGroupMembers] = useState<string[]>([])
  const isMobile = useIsMobile()
  useLang()
  const [mobileView, setMobileView] = useState<'list' | 'chat'>('list')

  // 点会话（含重复点同一个）必切到聊天视图：订阅 openConv 的显式 tick——
  // 返回列表后 activeConvId 未变，依赖它的 effect/equality 检查都不会触发
  //（已修的 bug：再点同一会话卡在列表）
  const convOpenTick = useStore(s => s.convOpenTick)
  useEffect(() => {
    if (isMobile && convOpenTick > 0) setMobileView('chat')
  }, [isMobile, convOpenTick])
  // 设备切换（调试拖窗）：从桌面态进移动态时，有活跃会话则直接落聊天视图
  useEffect(() => {
    if (isMobile && activeConvId) setMobileView('chat')
  }, [isMobile, activeConvId])

  const activeConv: ConvItem | null =
    useMemo(() => convs.find(c => c.id === activeConvId) || null,
            [convs, activeConvId])

  const convTitle = activeConv
    ? (activeConv.type === 'group'
        ? (activeConv.name || t('conv.group'))
        : activeConv.members.filter(m => m !== me?.username)[0] || activeConv.id)
    : 'AgentChat'
  const peerOnline = activeConv?.type === 'private'
    ? users.find(u => u.username === convTitle)?.online : undefined

  const openCreateGroup = async () => {
    try {
      const r = await fetchUsers()
      setGroupMembers(r.users.filter(u => u.username !== me?.username).map(u => u.username))
      setCreateGroupOpen(true)
    } catch (e: any) { message.error(e.message) }
  }

  const doCreateGroup = async () => {
    if (!groupName.trim()) return
    try {
      const conv = await createGroup(groupName.trim(), [])
      setCreateGroupOpen(false); setGroupName('')
      await loadConvs()
      openConv(conv.id)
    } catch (e: any) { message.error(e.message) }
  }

  // 标题栏内容（头像/名称/在线/群信息）：桌面与移动聊天视图共用
  const headerContent = (<>
    {activeConv?.type === 'private' ? (
      // 私聊：头像与名字都可点击 → 打开对方 Profile 卡片
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <UserProfileCard username={convTitle}>
          <Avatar style={{ background: convColor(convTitle) }}>
            {convTitle[0]?.toUpperCase()}
          </Avatar>
        </UserProfileCard>
        <UserProfileCard username={convTitle}>
          <b style={{ fontSize: 15, cursor: 'pointer' }}>{convTitle}</b>
        </UserProfileCard>
      </span>
    ) : (
      // 群聊：方型头像 + 群名，点击（头像/名称均可）打开群信息
      <span onClick={() => setGroupInfoOpen(true)}
            title={activeConv?.desc || undefined}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8,
                     cursor: 'pointer' }}>
        <Avatar shape="square" style={{ background: convColor(convTitle) }}>
          {convTitle[0]?.toUpperCase()}
        </Avatar>
        <b style={{ fontSize: 15 }}>{convTitle}</b>
      </span>
    )}
    {peerOnline !== undefined && (
      <span style={{ marginLeft: 10, display: 'inline-flex',
                     alignItems: 'center', gap: 5, fontSize: 12, color: '#888' }}>
        <Badge dot status={peerOnline ? 'success' : 'default'} />
        {peerOnline ? t('common.online') : t('common.offline')}
      </span>
    )}
    {activeConv?.type === 'group' && (
      <Button type="text" icon={<TeamOutlined />} style={{ marginLeft: 'auto' }}
              onClick={() => setGroupInfoOpen(true)}>
        {t('chat.groupInfo')}（{activeConv.members.length}）
      </Button>
    )}
  </>)

  // 弹层（桌面/移动共用）
  const overlays = (<>
    <GroupInfo open={groupInfoOpen} conv={activeConv}
               onClose={() => setGroupInfoOpen(false)} />
    <UserDirectory open={dirOpen} onClose={() => setDirOpen(false)} />
    <Modal title={t('chat.createGroupTitle')} open={createGroupOpen}
           onCancel={() => setCreateGroupOpen(false)}
           onOk={doCreateGroup} okText={t('chat.create')} cancelText={t('common.cancel')}>
      <Input placeholder={t('chat.groupNamePlaceholder')} value={groupName}
             onChange={e => setGroupName(e.target.value)} autoFocus
             onPressEnter={doCreateGroup} />
    </Modal>
  </>)

  // ---------- 移动端布局：列表视图 ↔ 聊天视图 切换 ----------
  if (isMobile) {
    return (
      <Layout style={{ height: 'var(--app-height, 100vh)' }}>
        {mobileView === 'list' ? (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ height: 48, flexShrink: 0, display: 'flex', alignItems: 'center',
                          padding: '0 14px', fontWeight: 600, fontSize: 16,
                          borderBottom: '1px solid #f0f0f0' }}>
              AgentChat
              <span style={{ marginLeft: 'auto', fontWeight: 400, fontSize: 13,
                             display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {me?.role === 'admin' && (
                  <a onClick={() => { location.hash = '#/admin' }}>{t('chat.adminPage')}</a>
                )}
                <b>{me?.username}</b>
                <Button type="text" size="small" icon={<LogoutOutlined />}
                        onClick={logout} title={t('chat.logout')} />
              </span>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <ConvList onOpenDirectory={() => setDirOpen(true)}
                        onCreateGroup={openCreateGroup} />
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* 标题栏动态高度：在最新消息位置时加高，向前翻历史时收窄（与桌面一致） */}
            <div style={{ height: msgAtBottom ? 56 : 44, transition: 'height 0.2s',
                          flexShrink: 0, display: 'flex', alignItems: 'center',
                          padding: '0 8px', borderBottom: '1px solid #f0f0f0',
                          background: '#fff', overflow: 'hidden', gap: 2 }}>
              <Button type="text" icon={<ArrowLeftOutlined />}
                      onClick={() => setMobileView('list')}
                      title={t('chat.backToList')} />
              <span style={{ overflow: 'hidden' }}>{headerContent}</span>
            </div>
            <Content style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <MessageList />
              <Composer />
            </Content>
          </div>
        )}
        {overlays}
      </Layout>
    )
  }

  // ---------- 桌面布局（三栏，现状） ----------
  return (
    <Layout style={{ height: 'var(--app-height, 100vh)' }}>
      {/* antd Sider 的内容包在 .ant-layout-sider-children 里（不是 flex 容器，
          写在 Sider 根上的 flex 布局对它无效，会话多时会把侧栏撑高溢出视口）——
          这里显式让 children 也成为 flex 列容器，会话列表才能正确滚动 */}
      <style>{`.chat-sider > .ant-layout-sider-children{display:flex;flex-direction:column;min-height:0}`}</style>
      <Sider width={280} theme="light" className="chat-sider"
             style={{ borderRight: '1px solid #f0f0f0', display: 'flex',
                      flexDirection: 'column' }}>
        <div style={{ height: 48, display: 'flex', alignItems: 'center',
                      padding: '0 14px', fontWeight: 600, fontSize: 16,
                      borderBottom: '1px solid #f0f0f0' }}>
          AgentChat
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <ConvList onOpenDirectory={() => setDirOpen(true)}
                    onCreateGroup={openCreateGroup} />
        </div>
        <div style={{ borderTop: '1px solid #f0f0f0', padding: '8px 14px',
                      display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center', fontSize: 13 }}>
          <span>
            <b>{me?.username}</b>
            {me?.role === 'admin' && (
              <a style={{ marginLeft: 8, fontSize: 12 }}
                 onClick={() => { location.hash = '#/admin' }}>{t('chat.adminPage')}</a>
            )}
          </span>
          <Button type="text" size="small" icon={<LogoutOutlined />}
                  onClick={logout} title={t('chat.logout')} />
        </div>
      </Sider>

      <Layout>
        {/* 标题栏动态高度：在最新消息位置时加高（头像舒展），向前翻历史时收窄——
            一眼可辨当前是否在最新位置。flexShrink:0 防止被 antd Layout 的 flex 压扁 */}
        <div style={{ height: msgAtBottom ? 60 : 44,
                      transition: 'height 0.2s', flexShrink: 0,
                      display: 'flex', alignItems: 'center',
                      padding: '0 16px', borderBottom: '1px solid #f0f0f0',
                      background: '#fff', overflow: 'hidden' }}>
          {headerContent}
        </div>
        <Content style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <MessageList />
          <Composer />
        </Content>
      </Layout>
      {overlays}
    </Layout>
  )
}

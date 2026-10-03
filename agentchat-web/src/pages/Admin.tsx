import { useEffect, useState } from 'react'
import { Alert, Button, Card, DatePicker, Form, Input, InputNumber, Modal,
         Popconfirm, Select, Space, Switch, Table, Tabs, Tag, message } from 'antd'
import { ClearOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import { ConvItem, UserItem, adminCreateUser, adminListConvs, adminSearchMessages,
         adminSettings, adminUpdateSettings, adminUpdateUser, fetchUsers } from '../api'
import { useStore } from '../store'
import { useIsMobile } from '../responsive'
import { t as T, useLang } from '../i18n'
import MetricsPanel from '../components/MetricsPanel'
import AdminGroupsTab from './AdminGroupsTab'
import Markdown from '../components/Markdown'

export default function Admin() {
  const logout = useStore(s => s.logout)
  const [activeKey, setActiveKey] = useState('users')
  // 历史查询 → 群管理消息面板的跳转载荷（切换 Tab + 打开面板并定位消息）
  useLang()
  const [groupJump, setGroupJump] = useState<{ convId: string; seq: number } | null>(null)

  return (
    <div style={{ height: 'var(--app-height, 100vh)',
                  display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: '#001529', color: '#fff', padding: '0 16px',
                    display: 'flex', alignItems: 'center', height: 48 }}>
        <b style={{ fontSize: 16 }}>{T('admin.title')}</b>
        <Space style={{ marginLeft: 'auto' }}>
          <Button size="small" ghost onClick={() => { location.hash = '#/' }}>
            {T('admin.backChat')}
          </Button>
          <Button size="small" ghost onClick={logout}>{T('chat.logout')}</Button>
        </Space>
      </div>
      {/* Tabs 占满剩余高度（content-holder/content 逐层满高），让群消息面板的
          内嵌滚动框真正成为滚动容器——否则高度链断裂、滚的是外层页面 */}
      <style>{`
        .admin-tabs { flex: 1; min-height: 0; display: flex; flex-direction: column; }
        .admin-tabs > .ant-tabs-content-holder { flex: 1; min-height: 0; }
        .admin-tabs > .ant-tabs-content-holder > .ant-tabs-content,
        .admin-tabs > .ant-tabs-content-holder > .ant-tabs-content > .ant-tabs-tabpane {
          height: 100%; min-height: 0;
        }
        .admin-tabs > .ant-tabs-nav { margin-bottom: 12px; }
      `}</style>
      <Tabs activeKey={activeKey} onChange={setActiveKey}
            style={{ padding: '0 16px' }} className="admin-tabs"
            items={[
              { key: 'users', label: T('admin.tab.users'), children: <UsersTab /> },
              { key: 'params', label: T('admin.tab.params'), children: <ParamsTab /> },
              { key: 'groups', label: T('admin.tab.groups'),
                children: <AdminGroupsTab jump={groupJump} onJumpDone={() => setGroupJump(null)} /> },
              { key: 'history', label: T('admin.tab.history'),
                children: <AdminHistoryTab onJumpGroup={(convId, seq) => {
                  setGroupJump({ convId, seq })
                  setActiveKey('groups')
                }} /> },
              { key: 'monitor', label: T('admin.tab.monitor'), children: <MetricsPanel /> },
            ]} />
    </div>
  )
}

function AdminHistoryTab({ onJumpGroup }: { onJumpGroup: (convId: string, seq: number) => void }) {
  const isMobile = useIsMobile()
  const users = useStore(s => s.users)
  const myConvs = useStore(s => s.convs)
  const jumpToMessage = useStore(s => s.jumpToMessage)
  const [allConvs, setAllConvs] = useState<ConvItem[]>([])

  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null)
  const [type, setType] = useState<string | undefined>(undefined)
  const [sender, setSender] = useState<string | undefined>(undefined)
  const [recipient, setRecipient] = useState<string | undefined>(undefined)
  const [q, setQ] = useState('')
  const [data, setData] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    adminListConvs().then(r => setAllConvs(r.conversations)).catch(() => {})
  }, [])

  const convLabel = (id: string) => {
    const c = allConvs.find(x => x.id === id)
    if (!c) return id.slice(0, 14) + '…'
    return c.type === 'group'
      ? T('conv.groupLabel').replace('{name}', c.name || T('conv.group'))
      : T('conv.privateLabel').replace('{name}', c.members.join(' ↔ '))
  }
  const canJump = (id: string) => {
    const c = allConvs.find(x => x.id === id)
    if (c?.type === 'group') return true          // 群：任意群可跳（走群管理消息面板）
    return myConvs.some(m => m.id === id)         // 私聊：保持现状（仅自己所在会话）
  }
  const doJump = (id: string, seq: number) => {
    const c = allConvs.find(x => x.id === id)
    if (c?.type === 'group') onJumpGroup(id, seq)
    else jumpToMessage(id, seq)
  }

  const run = async (p = 1, size = pageSize) => {
    setLoading(true)
    try {
      const r = await adminSearchMessages({
        type, sender, recipient, q: q || undefined,
        start: range?.[0]?.format('YYYY-MM-DD'),
        end: range?.[1]?.format('YYYY-MM-DD'),
        page: p, limit: size,
      })
      setData(r.messages); setTotal(r.total); setPage(p)
    } catch (e: any) { message.error(e.message) }
    finally { setLoading(false) }
  }
  const clearAll = async () => {
    setRange(null); setType(undefined); setSender(undefined)
    setRecipient(undefined); setQ('')
    setLoading(true)
    try {
      const r = await adminSearchMessages({ page: 1, limit: pageSize })
      setData(r.messages); setTotal(r.total); setPage(1)
    } catch (e: any) { message.error(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { run(1) }, [])   // eslint-disable-line

  return (
    <div style={{ margin: '12px 0' }}>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap size={[12, 8]}>
          <DatePicker.RangePicker value={range as any} onChange={setRange}
                                  placeholder={[T('history.startDate'), T('history.endDate')]} />
          <Select allowClear placeholder={T('history.msgType')} style={{ width: 110 }}
                  value={type} onChange={setType}
                  options={[{ value: 'text', label: T('history.text') },
                            { value: 'system', label: T('history.system') }]} />
          <Select allowClear placeholder={T('history.sender')} style={{ width: 150 }}
                  value={sender} onChange={setSender}
                  options={users.map(u => ({ value: u.username, label: u.username }))} />
          <Select allowClear placeholder={T('admin.history.recipient')} style={{ width: 170 }}
                  value={recipient} onChange={setRecipient}
                  options={users.map(u => ({ value: u.username, label: u.username }))} />
          <Input allowClear placeholder={T('history.keyword')} style={{ width: 170 }}
                 value={q} onChange={e => setQ(e.target.value)}
                 onPressEnter={() => run(1)} />
          <Button type="primary" icon={<SearchOutlined />}
                  loading={loading} onClick={() => run(1)}>{T('common.search')}</Button>
          <Button icon={<ClearOutlined />} onClick={clearAll}>{T('history.clear')}</Button>
          <span style={{ fontSize: 12, color: '#999' }}>
            {T('admin.history.serverWide')}
          </span>
        </Space>
      </Card>

      <Table rowKey="id" size="small" loading={loading} dataSource={data}
             scroll={{ y: 480, x: isMobile ? 800 : undefined }}
             expandable={{
               expandedRowRender: (m: any) => (
                 <div style={{ padding: '4px 8px', maxHeight: 300, overflowY: 'auto' }}>
                   <Markdown content={m.content} />
                 </div>
               ),
               rowExpandable: (m: any) => m.content.length > 80,
             }}
             pagination={{
               total, current: page, pageSize,
               showTotal: n => T('history.total').replace('{n}', String(n)),
               onChange: (p) => run(p),
               showSizeChanger: true,
               pageSizeOptions: ['50', '100', '200', '500', '1000'],
               onShowSizeChange: (_, size) => { setPageSize(size); run(1, size) },
             }}>
        <Table.Column title={T('history.time')} dataIndex="created_at" width={150}
                      render={(v: string) => (v || '').replace('T', ' ').slice(0, 19)} />
        <Table.Column title={T('history.conv')} dataIndex="conv_id" width={200}
                      render={(v: string, m: any) => canJump(v) ? (
                        <a onClick={() => doJump(m.conv_id, m.seq)}
                           title={T('history.jumpTo')}
                           style={{ fontSize: 13 }}>{convLabel(v)}</a>
                      ) : <span style={{ fontSize: 13, color: '#888' }}>{convLabel(v)}</span>} />
        <Table.Column title={T('history.sender')} dataIndex="sender" width={100} />
        <Table.Column title={T('history.msgType')} dataIndex="type" width={80}
                      render={(v: string) => v === 'system'
                        ? <Tag>{T('history.system')}</Tag> : <Tag color="blue">{T('history.text')}</Tag>} />
        <Table.Column title="Content" dataIndex="content"
                      render={(v: string, m: any) => (
                        <span style={{ color: m.type === 'system' ? '#999' : undefined }}>
                          {v.length > 80 ? v.slice(0, 80) + '…' : v}
                        </span>
                      )} />
      </Table>
    </div>
  )
}

function ParamsTab() {
  useLang()
  type FieldMeta = { default: number; min: number; max: number; label: string }
  const [form] = Form.useForm()
  const [fields, setFields] = useState<Record<string, FieldMeta>>({})
  const [saving, setSaving] = useState(false)

  const load = async () => {
    try {
      const r = await adminSettings()
      form.setFieldsValue(r.values)
      setFields(r.fields)
    } catch (e: any) { message.error(e.message) }
  }
  useEffect(() => { load() }, [])

  const save = async (vals: Record<string, number>) => {
    setSaving(true)
    try {
      await adminUpdateSettings(vals)
      message.success(T('admin.params.saved'))
      load()
    } catch (e: any) { message.error(e.message) }
    finally { setSaving(false) }
  }

  return (
    <Card size="small" style={{ margin: '12px 0', maxWidth: 520 }}>
      <Alert type="info" showIcon style={{ marginBottom: 16 }}
             message={T('admin.params.hint')} />
      <Form form={form} layout="vertical" onFinish={save}>
        {Object.entries(fields).map(([key, f]) => (
          <Form.Item key={key} name={key} label={f.label}
                     rules={[{ required: true },
                             { type: 'number', min: f.min, max: f.max,
                               message: T('admin.params.rangeHint').replace('{min}', String(f.min)).replace('{max}', String(f.max)) }]}
                     extra={T('admin.params.defaultHint').replace('{d}', String(f.default)).replace('{min}', String(f.min)).replace('{max}', String(f.max))}>
            <InputNumber min={f.min} max={f.max} precision={0}
                         style={{ width: '100%' }} />
          </Form.Item>
        ))}
        <Space>
          <Button type="primary" htmlType="submit" loading={saving}>{T('admin.params.save')}</Button>
          <Button onClick={load}>{T('admin.params.reload')}</Button>
        </Space>
      </Form>
    </Card>
  )
}

function UsersTab() {
  const isMobile = useIsMobile()
  useLang()
  const [users, setUsers] = useState<UserItem[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [resetFor, setResetFor] = useState<string | null>(null)
  const [form] = Form.useForm()
  const [resetForm] = Form.useForm()

  const load = async () => {
    setLoading(true)
    try { setUsers((await fetchUsers()).users) }
    catch (e: any) { message.error(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const doCreate = async (vals: { username: string; password: string }) => {
    try {
      await adminCreateUser(vals.username, vals.password)
      message.success(T('admin.users.createdOk').replace('{name}', vals.username))
      setCreateOpen(false); form.resetFields(); load()
    } catch (e: any) { message.error(e.message) }
  }

  const doReset = async (vals: { password: string }) => {
    try {
      await adminUpdateUser(resetFor!, { password: vals.password })
      message.success(T('admin.users.resetOk'))
      setResetFor(null); resetForm.resetFields()
    } catch (e: any) { message.error(e.message) }
  }

  const toggleDisabled = async (u: UserItem) => {
    try {
      await adminUpdateUser(u.username, { disabled: !u.disabled })
      load()
    } catch (e: any) { message.error(e.message) }
  }

  return (
    <Card size="small" style={{ margin: '12px 0' }}>
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          {T('admin.users.create')}
        </Button>
        <Button icon={<ReloadOutlined />} onClick={load}>{T('admin.users.refresh')}</Button>
      </Space>
      <Table rowKey="username" loading={loading} dataSource={users} size="small"
             pagination={false} scroll={{ x: isMobile ? 640 : undefined }}>
        <Table.Column title={T('admin.users.username')} dataIndex="username" />
        <Table.Column title={T('admin.users.roleCol')} dataIndex="role" width={90}
                      render={(r: string) => r === 'admin'
                        ? <Tag color="blue">admin</Tag> : <Tag>user</Tag>} />
        <Table.Column title={T('admin.users.online')} dataIndex="online" width={80}
                      render={(v: boolean) => v
                        ? <Tag color="green">{T('common.online')}</Tag> : <Tag>{T('common.offline')}</Tag>} />
        <Table.Column title={T('admin.users.status')} dataIndex="disabled" width={80}
                      render={(v: boolean) => v
                        ? <Tag color="red">{T('admin.users.disabled')}</Tag> : <Tag color="green">{T('admin.users.normal')}</Tag>} />
        <Table.Column title={T('admin.users.createdAt')} dataIndex="created_at" width={170}
                      render={(v: string) => v ? v.replace('T', ' ').slice(0, 19) : '-'} />
        <Table.Column title={T('admin.users.actionsCol')} width={230} render={(_: any, u: UserItem) => (
          <Space>
            <Button size="small" onClick={() => setResetFor(u.username)}>{T('admin.users.resetPwd')}</Button>
            <Popconfirm title={u.disabled ? T('admin.users.confirmEnable').replace('{name}', u.username)
                                          : T('admin.users.confirmDisable').replace('{name}', u.username)}
                        onConfirm={() => toggleDisabled(u)}>
              <Button size="small" danger={!u.disabled}>
                {u.disabled ? T('admin.users.enable') : T('admin.users.disable')}
              </Button>
            </Popconfirm>
          </Space>
        )} />
      </Table>

      <Modal title={T('admin.users.createTitle')} open={createOpen} onCancel={() => setCreateOpen(false)}
             onOk={() => form.submit()} okText={T('chat.create')} cancelText={T('common.cancel')}>
        <Form form={form} layout="vertical" onFinish={doCreate}>
          <Form.Item name="username" label={T('admin.users.username')}
                     rules={[{ required: true },
                             { pattern: /^[a-z0-9_-]{2,32}$/,
                               message: T('admin.users.usernameHint') }]}>
            <Input autoFocus />
          </Form.Item>
          <Form.Item name="password" label={T('admin.users.initPwd')}
                     rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={T('admin.users.resetTitle').replace('{name}', String(resetFor))} open={!!resetFor}
             onCancel={() => { setResetFor(null); resetForm.resetFields() }}
             onOk={() => resetForm.submit()} okText={T('admin.users.resetPwd')} cancelText={T('common.cancel')}>
        <Form form={resetForm} layout="vertical" onFinish={doReset}>
          <Form.Item name="password" label={T('admin.users.newPwd')} rules={[{ required: true }]}>
            <Input.Password autoFocus />
          </Form.Item>
          <Form.Item name="password2" label={T('admin.users.confirmPwd')} dependencies={['password']}
                     rules={[{ required: true },
                             ({ getFieldValue }) => ({
                               validator(_, value) {
                                 if (!value || value === getFieldValue('password'))
                                   return Promise.resolve()
                                 return Promise.reject(new Error(T('admin.users.pwdMismatch')))
                               },
                             })]}>
            <Input.Password onPressEnter={() => resetForm.submit()} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

import { useEffect, useState } from 'react'
import { Alert, Button, Card, DatePicker, Form, Input, InputNumber, Modal,
         Popconfirm, Select, Space, Switch, Table, Tabs, Tag, message } from 'antd'
import { ClearOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import { ConvItem, UserItem, adminCreateUser, adminListConvs, adminSearchMessages,
         adminSettings, adminUpdateSettings, adminUpdateUser, fetchUsers } from '../api'
import { useStore } from '../store'
import { useIsMobile } from '../responsive'
import MetricsPanel from '../components/MetricsPanel'
import Markdown from '../components/Markdown'

export default function Admin() {
  const logout = useStore(s => s.logout)

  return (
    <div style={{ height: 'var(--app-height, 100vh)',
                  display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: '#001529', color: '#fff', padding: '0 16px',
                    display: 'flex', alignItems: 'center', height: 48 }}>
        <b style={{ fontSize: 16 }}>AgentChat 管理后台</b>
        <Space style={{ marginLeft: 'auto' }}>
          <Button size="small" ghost onClick={() => { location.hash = '#/' }}>
            返回聊天
          </Button>
          <Button size="small" ghost onClick={logout}>退出登录</Button>
        </Space>
      </div>
      <Tabs defaultActiveKey="users" style={{ padding: '0 16px' }}
            items={[
              { key: 'users', label: '账号管理', children: <UsersTab /> },
              { key: 'params', label: '系统参数', children: <ParamsTab /> },
              { key: 'history', label: '历史消息查询', children: <AdminHistoryTab /> },
              { key: 'monitor', label: '统计与监控', children: <MetricsPanel /> },
            ]} />
    </div>
  )
}

function AdminHistoryTab() {
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
      ? `群：${c.name || '群聊'}`
      : `私聊：${c.members.join(' ↔ ')}`
  }
  const canJump = (id: string) => myConvs.some(m => m.id === id)

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
                                  placeholder={['开始日期', '结束日期']} />
          <Select allowClear placeholder="消息类型" style={{ width: 110 }}
                  value={type} onChange={setType}
                  options={[{ value: 'text', label: '文本' },
                            { value: 'system', label: '系统' }]} />
          <Select allowClear placeholder="人员（发送者）" style={{ width: 150 }}
                  value={sender} onChange={setSender}
                  options={users.map(u => ({ value: u.username, label: u.username }))} />
          <Select allowClear placeholder="接收人（仅私聊消息）" style={{ width: 170 }}
                  value={recipient} onChange={setRecipient}
                  options={users.map(u => ({ value: u.username, label: u.username }))} />
          <Input allowClear placeholder="关键词（可选）" style={{ width: 170 }}
                 value={q} onChange={e => setQ(e.target.value)}
                 onPressEnter={() => run(1)} />
          <Button type="primary" icon={<SearchOutlined />}
                  loading={loading} onClick={() => run(1)}>查询</Button>
          <Button icon={<ClearOutlined />} onClick={clearAll}>清空条件</Button>
          <span style={{ fontSize: 12, color: '#999' }}>
            全服查询；群/系统消息无接收人；点击自己所在的会话名可跳转
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
               showTotal: t => `共 ${t} 条`,
               onChange: (p) => run(p),
               showSizeChanger: true,
               pageSizeOptions: ['50', '100', '200', '500', '1000'],
               onShowSizeChange: (_, size) => { setPageSize(size); run(1, size) },
             }}>
        <Table.Column title="时间" dataIndex="created_at" width={150}
                      render={(v: string) => (v || '').replace('T', ' ').slice(0, 19)} />
        <Table.Column title="会话" dataIndex="conv_id" width={200}
                      render={(v: string, m: any) => canJump(v) ? (
                        <a onClick={() => jumpToMessage(m.conv_id, m.seq)}
                           title="跳转到该会话并定位此消息"
                           style={{ fontSize: 13 }}>{convLabel(v)}</a>
                      ) : <span style={{ fontSize: 13, color: '#888' }}>{convLabel(v)}</span>} />
        <Table.Column title="发送者" dataIndex="sender" width={100} />
        <Table.Column title="类型" dataIndex="type" width={80}
                      render={(v: string) => v === 'system'
                        ? <Tag>系统</Tag> : <Tag color="blue">文本</Tag>} />
        <Table.Column title="内容" dataIndex="content"
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
      message.success('已保存，立即生效')
      load()
    } catch (e: any) { message.error(e.message) }
    finally { setSaving(false) }
  }

  return (
    <Card size="small" style={{ margin: '12px 0', maxWidth: 520 }}>
      <Alert type="info" showIcon style={{ marginBottom: 16 }}
             message="系统参数保存后立即生效，无需重启服务；重启后保持已保存的值" />
      <Form form={form} layout="vertical" onFinish={save}>
        {Object.entries(fields).map(([key, f]) => (
          <Form.Item key={key} name={key} label={f.label}
                     rules={[{ required: true },
                             { type: 'number', min: f.min, max: f.max,
                               message: `取值范围 ${f.min} ~ ${f.max}` }]}
                     extra={`默认 ${f.default}，范围 ${f.min} ~ ${f.max}`}>
            <InputNumber min={f.min} max={f.max} precision={0}
                         style={{ width: '100%' }} />
          </Form.Item>
        ))}
        <Space>
          <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
          <Button onClick={load}>重新加载</Button>
        </Space>
      </Form>
    </Card>
  )
}

function UsersTab() {
  const isMobile = useIsMobile()
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
      message.success(`已创建 ${vals.username}`)
      setCreateOpen(false); form.resetFields(); load()
    } catch (e: any) { message.error(e.message) }
  }

  const doReset = async (vals: { password: string }) => {
    try {
      await adminUpdateUser(resetFor!, { password: vals.password })
      message.success('密码已重置')
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
          新建账号
        </Button>
        <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
      </Space>
      <Table rowKey="username" loading={loading} dataSource={users} size="small"
             pagination={false} scroll={{ x: isMobile ? 640 : undefined }}>
        <Table.Column title="用户名" dataIndex="username" />
        <Table.Column title="角色" dataIndex="role" width={90}
                      render={(r: string) => r === 'admin'
                        ? <Tag color="blue">admin</Tag> : <Tag>user</Tag>} />
        <Table.Column title="在线" dataIndex="online" width={80}
                      render={(v: boolean) => v
                        ? <Tag color="green">在线</Tag> : <Tag>离线</Tag>} />
        <Table.Column title="状态" dataIndex="disabled" width={80}
                      render={(v: boolean) => v
                        ? <Tag color="red">禁用</Tag> : <Tag color="green">正常</Tag>} />
        <Table.Column title="创建时间" dataIndex="created_at" width={170}
                      render={(v: string) => v ? v.replace('T', ' ').slice(0, 19) : '-'} />
        <Table.Column title="操作" width={230} render={(_: any, u: UserItem) => (
          <Space>
            <Button size="small" onClick={() => setResetFor(u.username)}>重置密码</Button>
            <Popconfirm title={u.disabled ? `启用 ${u.username}？`
                                          : `禁用 ${u.username}？（会立即踢下线）`}
                        onConfirm={() => toggleDisabled(u)}>
              <Button size="small" danger={!u.disabled}>
                {u.disabled ? '启用' : '禁用'}
              </Button>
            </Popconfirm>
          </Space>
        )} />
      </Table>

      <Modal title="新建账号" open={createOpen} onCancel={() => setCreateOpen(false)}
             onOk={() => form.submit()} okText="创建" cancelText="取消">
        <Form form={form} layout="vertical" onFinish={doCreate}>
          <Form.Item name="username" label="用户名"
                     rules={[{ required: true },
                             { pattern: /^[a-z0-9_-]{2,32}$/,
                               message: '小写字母/数字/_/-，2-32 位' }]}>
            <Input autoFocus />
          </Form.Item>
          <Form.Item name="password" label="初始密码"
                     rules={[{ required: true }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={`重置密码：${resetFor}`} open={!!resetFor}
             onCancel={() => { setResetFor(null); resetForm.resetFields() }}
             onOk={() => resetForm.submit()} okText="重置" cancelText="取消">
        <Form form={resetForm} layout="vertical" onFinish={doReset}>
          <Form.Item name="password" label="新密码" rules={[{ required: true }]}>
            <Input.Password autoFocus />
          </Form.Item>
          <Form.Item name="password2" label="确认新密码" dependencies={['password']}
                     rules={[{ required: true },
                             ({ getFieldValue }) => ({
                               validator(_, value) {
                                 if (!value || value === getFieldValue('password'))
                                   return Promise.resolve()
                                 return Promise.reject(new Error('两次输入的密码不一致'))
                               },
                             })]}>
            <Input.Password onPressEnter={() => resetForm.submit()} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

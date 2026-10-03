import { useEffect, useState } from 'react'
import { Button, Card, DatePicker, Input, Popconfirm, Select, Space,
         Table, Tag, message } from 'antd'
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import { AdminGroup, UserItem, adminDissolveGroup, adminListGroups, fetchUsers } from '../api'
import { t as T, useLang } from '../i18n'
import AdminGroupPanel from './AdminGroupPanel'

/** 管理页「群管理」Tab：全部群列表（分页/筛选/解散）+ 点击群名进只读消息面板 */
export default function AdminGroupsTab({ jump, onJumpDone }: {
  jump?: { convId: string; seq: number } | null
  onJumpDone?: () => void }) {
  const [users, setUsers] = useState<UserItem[]>([])
  useLang()
  const [groups, setGroups] = useState<AdminGroup[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [loading, setLoading] = useState(false)
  // 筛选条件
  const [q, setQ] = useState('')
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null)
  const [member, setMember] = useState<string | undefined>(undefined)
  // 已在本会话解散的群（按钮置灰）
  const [dissolved, setDissolved] = useState<Set<string>>(new Set())
  // 只读面板（jump 带定位 seq：历史查询跳转进来时打开即定位该消息）
  const [panelConvId, setPanelConvId] = useState<string | null>(null)
  const [panelSeq, setPanelSeq] = useState<number | null>(null)

  useEffect(() => {
    if (jump) {
      setPanelSeq(jump.seq)
      setPanelConvId(jump.convId)
      onJumpDone?.()
    }
  }, [jump])

  const load = async (p = page, size = pageSize) => {
    setLoading(true)
    try {
      const r = await adminListGroups({
        q: q || undefined,
        start: range?.[0]?.format('YYYY-MM-DD'),
        end: range?.[1]?.format('YYYY-MM-DD'),
        member, page: p, limit: size,
      })
      setGroups(r.groups); setTotal(r.total); setPage(p)
    } catch (e: any) { message.error(e.message) }
    finally { setLoading(false) }
  }

  useEffect(() => {
    load(1)
    fetchUsers().then(r => setUsers(r.users)).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const doDissolve = async (g: AdminGroup) => {
    try {
      await adminDissolveGroup(g.id)
      message.success(T('admin.groups.confirmDissolveOk').replace('{name}', String(g.name)))
      setDissolved(prev => new Set(prev).add(g.id))
      load()
    } catch (e: any) { message.error(e.message) }
  }

  if (panelConvId) {
    return <AdminGroupPanel convId={panelConvId} initialSeq={panelSeq} onBack={() => {
      setPanelConvId(null); setPanelSeq(null); load()
    }} />
  }

  return (
    <div style={{ margin: '12px 0' }}>
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap size={[12, 8]}>
          <Input allowClear placeholder={T('admin.groups.searchPlaceholder')} style={{ width: 190 }}
                 value={q} onChange={e => setQ(e.target.value)}
                 onPressEnter={() => load(1)} />
          <DatePicker.RangePicker value={range as any} onChange={setRange}
                                  placeholder={[T('admin.groups.createdAtStart'), T('admin.groups.createdAtEnd')]} />
          <Select allowClear placeholder={T('admin.groups.containsMember')} style={{ width: 150 }}
                  value={member} onChange={v => setMember(v)}
                  showSearch optionFilterProp="label"
                  options={users.map(u => ({ value: u.username, label: u.username }))} />
          <Button type="primary" icon={<SearchOutlined />}
                  loading={loading} onClick={() => load(1)}>{T('common.search')}</Button>
          <Button icon={<ReloadOutlined />} onClick={() => {
            setQ(''); setRange(null); setMember(undefined)
            setTimeout(() => load(1), 0)
          }}>{T('common.reset')}</Button>
          <span style={{ fontSize: 12, color: '#999' }}>
            {T('admin.groups.totalGroups').replace('{n}', String(total))}；{T('admin.groups.hint')}
          </span>
        </Space>
      </Card>

      <Table rowKey="id" size="small" loading={loading} dataSource={groups}
             pagination={{
               total, current: page, pageSize,
               showTotal: n => T('admin.groups.totalGroups').replace('{n}', String(n)),
               showSizeChanger: true,
               pageSizeOptions: ['10', '20', '50', '100'],
               onChange: (p, s) => { setPageSize(s); load(p, s) },
             }}>
        <Table.Column title={T('admin.groups.name')} dataIndex="name" render={(v: string, g: AdminGroup) => (
          dissolved.has(g.id)
            ? <span style={{ color: '#bbb' }}>{v}（{T('admin.groups.dissolved')}）</span>
            : <a onClick={() => setPanelConvId(g.id)}
                 title={T('admin.groups.openPanel')}>{v}</a>
        )} />
        <Table.Column title={T('admin.groups.owner')} dataIndex="owner" width={110}
                      render={(v: string) => <b>{v}</b>} />
        <Table.Column title={T('admin.groups.desc')} dataIndex="desc" ellipsis
                      render={(v: string) => v || <span style={{ color: '#bbb' }}>—</span>} />
        <Table.Column title={T('admin.groups.memberCount')} dataIndex="member_count" width={80} />
        <Table.Column title={T('admin.groups.msgCount')} dataIndex="msg_count" width={90}
                      render={(v: number) => (v ?? 0).toLocaleString()} />
        <Table.Column title={T('admin.groups.createdAt')} dataIndex="created_at" width={170}
                      render={(v: string) => v ? v.replace('T', ' ').slice(0, 19) : '-'} />
        <Table.Column title={T('admin.groups.lastMsg')} dataIndex="last_msg_at" width={170}
                      render={(v: string) => v ? v.replace('T', ' ').slice(0, 19) : '-'} />
        <Table.Column title={T('admin.groups.actions')} width={110} render={(_: any, g: AdminGroup) => {
          const gone = dissolved.has(g.id)
          return gone
            ? <Button size="small" disabled>{T('admin.groups.dissolve')}</Button>
            : <Popconfirm title={T('admin.groups.dissolveConfirm').replace('{name}', String(g.name))}
                          onConfirm={() => doDissolve(g)}>
                <Button size="small" danger>{T('admin.groups.dissolve')}</Button>
              </Popconfirm>
        }} />
      </Table>
    </div>
  )
}

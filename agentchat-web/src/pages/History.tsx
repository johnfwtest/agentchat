import { useEffect, useState } from 'react'
import { Button, Card, DatePicker, Input, Select, Space, Table, Tag, message } from 'antd'
import { SearchOutlined, ClearOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import { Msg, SearchParams, SearchResult, searchMessages } from '../api'
import { useStore } from '../store'
import { useIsMobile } from '../responsive'
import Markdown from '../components/Markdown'

export default function History() {
  const isMobile = useIsMobile()
  const me = useStore(s => s.me)
  const convs = useStore(s => s.convs)
  const users = useStore(s => s.users)
  const jumpToMessage = useStore(s => s.jumpToMessage)

  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null)
  const [type, setType] = useState<string | undefined>(undefined)
  const [sender, setSender] = useState<string | undefined>(undefined)
  const [convId, setConvId] = useState<string | undefined>(undefined)
  const [q, setQ] = useState('')
  const [data, setData] = useState<Msg[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [loading, setLoading] = useState(false)

  const convLabel = (id: string) => {
    const c = convs.find(x => x.id === id)
    if (!c) return id.slice(0, 14) + '…'
    return c.type === 'group'
      ? `群：${c.name || '群聊'}`
      : `私聊：${c.members.filter(m => m !== me?.username)[0] || id}`
  }

  const run = async (p = 1, size = pageSize) => {
    setLoading(true)
    try {
      const r = await searchMessages({
        type, sender, conv_id: convId, q: q || undefined,
        start: range?.[0]?.format('YYYY-MM-DD'),
        end: range?.[1]?.format('YYYY-MM-DD'),
        page: p, limit: size,
      } as SearchParams)
      setData(r.messages); setTotal(r.total); setPage(p)
    } catch (e: any) { message.error(e.message) }
    finally { setLoading(false) }
  }
  const clearAll = async () => {
    setRange(null); setType(undefined); setSender(undefined)
    setConvId(undefined); setQ('')
    // setState 异步生效，这里直接用空条件查询（不依赖新 state）
    setLoading(true)
    try {
      const r = await searchMessages({ page: 1, limit: pageSize })
      setData(r.messages); setTotal(r.total); setPage(1)
    } catch (e: any) { message.error(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { run(1) }, [])   // eslint-disable-line

  return (
    <div style={{ height: 'var(--app-height, 100vh)',
                  display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: '#001529', color: '#fff', padding: '0 16px',
                    display: 'flex', alignItems: 'center', height: 48 }}>
        <b style={{ fontSize: 16 }}>历史消息查询</b>
        <span style={{ marginLeft: 12, fontSize: 12, color: '#aaa' }}>
          仅可检索你所在的会话
        </span>
        <Space style={{ marginLeft: 'auto' }}>
          <Button size="small" ghost onClick={() => { location.hash = '#/' }}>
            返回聊天
          </Button>
        </Space>
      </div>

      <Card size="small" style={{ margin: '12px 16px 0' }}>
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
          <Select allowClear placeholder="会话" style={{ width: 200 }}
                  value={convId} onChange={setConvId}
                  options={convs.map(c => ({ value: c.id, label: convLabel(c.id) }))} />
          <Input allowClear placeholder="关键词（可选）" style={{ width: 170 }}
                 value={q} onChange={e => setQ(e.target.value)}
                 onPressEnter={() => run(1)} />
          <Button type="primary" icon={<SearchOutlined />}
                  loading={loading} onClick={() => run(1)}>查询</Button>
          <Button icon={<ClearOutlined />} onClick={clearAll}>清空条件</Button>
        </Space>
      </Card>

      <Card size="small" style={{ margin: '12px 16px', flex: 1, minHeight: 0 }}>
        <Table rowKey="id" size="small" loading={loading} dataSource={data}
               scroll={{ y: 'calc(var(--app-height, 100vh) - 300px)',
                    x: isMobile ? 800 : undefined }}
               expandable={{
                 expandedRowRender: (m: Msg) => (
                   <div style={{ padding: '4px 8px', maxHeight: 300, overflowY: 'auto' }}>
                     <Markdown content={m.content} />
                   </div>
                 ),
                 rowExpandable: (m: Msg) => m.content.length > 80,
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
          <Table.Column title="会话" dataIndex="conv_id" width={170}
                        render={(v: string, m: Msg) => (
                          <a onClick={() => jumpToMessage(m.conv_id, m.seq)}
                             title="跳转到该会话并定位此消息"
                             style={{ fontSize: 13 }}>{convLabel(v)}</a>
                        )} />
          <Table.Column title="发送者" dataIndex="sender" width={100} />
          <Table.Column title="类型" dataIndex="type" width={80}
                        render={(v: string) => v === 'system'
                          ? <Tag>系统</Tag> : <Tag color="blue">文本</Tag>} />
          <Table.Column title="内容" dataIndex="content"
                        render={(v: string, m: Msg) => (
                          <span style={{ color: m.type === 'system' ? '#999' : undefined }}>
                            {v.length > 80 ? v.slice(0, 80) + '…' : v}
                          </span>
                        )} />
        </Table>
      </Card>
    </div>
  )
}

import { t as T, useLang } from '../i18n'
import { useEffect, useState } from 'react'
import { Card, Col, Progress, Row, Statistic } from 'antd'
import { adminMetrics, adminStats } from '../api'

const fmtBytes = (n?: number | null) => {
  if (!n && n !== 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(1)} ${units[i]}`
}

export default function MetricsPanel() {
  useLang()
  const [stats, setStats] = useState<any>(null)
  const [metrics, setMetrics] = useState<any>(null)

  useEffect(() => {
    const tick = async () => {
      try {
        const [s, m] = await Promise.all([adminStats(), adminMetrics()])
        setStats(s); setMetrics(m)
      } catch { /* 忽略轮询错误 */ }
    }
    tick()
    const t = setInterval(tick, 5000)
    return () => clearInterval(t)
  }, [])

  if (!stats || !metrics) return <Card loading style={{ margin: 16 }} />

  const { host, redis, mongo } = metrics
  return (
    <div style={{ padding: 16 }}>
      <Row gutter={[12, 12]}>
        <Col span={4}><Card size="small">
          <Statistic title={T('admin.monitor.users')} value={stats.users.total} /></Card></Col>
        <Col span={4}><Card size="small">
          <Statistic title={T('admin.monitor.online')} value={stats.users.online} /></Card></Col>
        <Col span={4}><Card size="small">
          <Statistic title={T('admin.users.disabled')} value={stats.users.disabled} /></Card></Col>
        <Col span={4}><Card size="small">
          <Statistic title={T('conv.group')} value={stats.conversations.group} /></Card></Col>
        <Col span={4}><Card size="small">
          <Statistic title={T('conv.private')} value={stats.conversations.private} /></Card></Col>
        <Col span={4}><Card size="small">
          <Statistic title={T('admin.monitor.msgsToday')} value={stats.messages.today}
                     suffix={`/ ${stats.messages.total}`} /></Card></Col>
      </Row>

      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col span={8}><Card size="small" title="CPU">
          <Progress percent={host.cpu_percent} status="active" />
          <div style={{ color: '#888', fontSize: 12 }}>
            {host.cpu_count} {T('admin.monitor.cores')} · {T('admin.monitor.uptime')} {Math.floor(host.uptime_sec / 3600)}{T('admin.monitor.hours')}
          </div>
        </Card></Col>
        <Col span={8}><Card size="small" title='Memory'>
          <Progress percent={host.mem.percent}
                    status={host.mem.percent > 85 ? 'exception' : 'normal'} />
          <div style={{ color: '#888', fontSize: 12 }}>
            {fmtBytes(host.mem.used)} / {fmtBytes(host.mem.total)}
          </div>
        </Card></Col>
        <Col span={8}><Card size="small" title='Disk'>
          <Progress percent={host.disk.percent}
                    status={host.disk.percent > 85 ? 'exception' : 'normal'} />
          <div style={{ color: '#888', fontSize: 12 }}>
            {fmtBytes(host.disk.used)} / {fmtBytes(host.disk.total)}
          </div>
        </Card></Col>
      </Row>

      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col span={8}><Card size="small" title='Network'>
          <div style={{ fontSize: 13, lineHeight: '24px' }}>
            <div>{T('metrics.connections')}<b>{host.net.connections}</b></div>
            <div>{T('metrics.sendRate')}<b>{fmtBytes(host.net.send_rate_bps)}/s</b></div>
            <div>{T('metrics.recvRate')}<b>{fmtBytes(host.net.recv_rate_bps)}/s</b></div>
          </div>
        </Card></Col>
        <Col span={8}><Card size="small" title="Redis">
          <div style={{ fontSize: 13, lineHeight: '24px' }}>
            <div>{T('metrics.clients')}<b>{redis.connected_clients}</b></div>
            <div>{T('metrics.mem')}<b>{redis.used_memory_human}</b></div>
            <div>ops/s：<b>{redis.ops_per_sec}</b></div>
            <div>{T('metrics.hitRate')}<b>
              {redis.keyspace_hits + redis.keyspace_misses > 0
                ? Math.round(redis.keyspace_hits /
                    (redis.keyspace_hits + redis.keyspace_misses) * 100) : 0}%
            </b>（{redis.keyspace_hits}/{redis.keyspace_hits + redis.keyspace_misses}）
            </div>
          </div>
        </Card></Col>
        <Col span={8}><Card size="small" title="MongoDB">
          <div style={{ fontSize: 13, lineHeight: '24px' }}>
            <div>{T('metrics.conn')}<b>{mongo.connections?.current ?? '-'}</b>
              （{T('metrics.available')} {mongo.connections?.available ?? '-'}）</div>
            <div>{T('metrics.capacity')}<b>{fmtBytes(mongo.db?.storage_size)}</b>
              <span style={{ color: '#888' }}>
                （{T('metrics.dataSize')} {fmtBytes(mongo.db?.data_size)}）
              </span></div>
            <div>insert/query：<b>
              {mongo.opcounters?.insert ?? '-'} / {mongo.opcounters?.query ?? '-'}
            </b></div>
            <div>update/delete：<b>
              {mongo.opcounters?.update ?? '-'} / {mongo.opcounters?.delete ?? '-'}
            </b></div>
            <div>{T('metrics.uptime')}<b>
              {mongo.uptime_sec ? Math.floor(mongo.uptime_sec / 3600) + T('admin.monitor.hours') : '-'}
            </b></div>
          </div>
        </Card></Col>
      </Row>
    </div>
  )
}

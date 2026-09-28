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
          <Statistic title="用户总数" value={stats.users.total} /></Card></Col>
        <Col span={4}><Card size="small">
          <Statistic title="在线" value={stats.users.online} /></Card></Col>
        <Col span={4}><Card size="small">
          <Statistic title="禁用" value={stats.users.disabled} /></Card></Col>
        <Col span={4}><Card size="small">
          <Statistic title="群聊" value={stats.conversations.group} /></Card></Col>
        <Col span={4}><Card size="small">
          <Statistic title="私聊" value={stats.conversations.private} /></Card></Col>
        <Col span={4}><Card size="small">
          <Statistic title="今日消息" value={stats.messages.today}
                     suffix={`/ ${stats.messages.total}`} /></Card></Col>
      </Row>

      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col span={8}><Card size="small" title="CPU">
          <Progress percent={host.cpu_percent} status="active" />
          <div style={{ color: '#888', fontSize: 12 }}>
            {host.cpu_count} 核 · 运行 {Math.floor(host.uptime_sec / 3600)} 小时
          </div>
        </Card></Col>
        <Col span={8}><Card size="small" title="内存">
          <Progress percent={host.mem.percent}
                    status={host.mem.percent > 85 ? 'exception' : 'normal'} />
          <div style={{ color: '#888', fontSize: 12 }}>
            {fmtBytes(host.mem.used)} / {fmtBytes(host.mem.total)}
          </div>
        </Card></Col>
        <Col span={8}><Card size="small" title="磁盘">
          <Progress percent={host.disk.percent}
                    status={host.disk.percent > 85 ? 'exception' : 'normal'} />
          <div style={{ color: '#888', fontSize: 12 }}>
            {fmtBytes(host.disk.used)} / {fmtBytes(host.disk.total)}
          </div>
        </Card></Col>
      </Row>

      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col span={8}><Card size="small" title="网络">
          <div style={{ fontSize: 13, lineHeight: '24px' }}>
            <div>连接数：<b>{host.net.connections}</b></div>
            <div>发送速率：<b>{fmtBytes(host.net.send_rate_bps)}/s</b></div>
            <div>接收速率：<b>{fmtBytes(host.net.recv_rate_bps)}/s</b></div>
          </div>
        </Card></Col>
        <Col span={8}><Card size="small" title="Redis">
          <div style={{ fontSize: 13, lineHeight: '24px' }}>
            <div>客户端连接：<b>{redis.connected_clients}</b></div>
            <div>内存：<b>{redis.used_memory_human}</b></div>
            <div>ops/s：<b>{redis.ops_per_sec}</b></div>
            <div>命中率：<b>
              {redis.keyspace_hits + redis.keyspace_misses > 0
                ? Math.round(redis.keyspace_hits /
                    (redis.keyspace_hits + redis.keyspace_misses) * 100) : 0}%
            </b>（{redis.keyspace_hits}/{redis.keyspace_hits + redis.keyspace_misses}）
            </div>
          </div>
        </Card></Col>
        <Col span={8}><Card size="small" title="MongoDB">
          <div style={{ fontSize: 13, lineHeight: '24px' }}>
            <div>连接：<b>{mongo.connections?.current ?? '-'}</b>
              （可用 {mongo.connections?.available ?? '-'}）</div>
            <div>容量：<b>{fmtBytes(mongo.db?.storage_size)}</b>
              <span style={{ color: '#888' }}>
                （数据 {fmtBytes(mongo.db?.data_size)}）
              </span></div>
            <div>insert/query：<b>
              {mongo.opcounters?.insert ?? '-'} / {mongo.opcounters?.query ?? '-'}
            </b></div>
            <div>update/delete：<b>
              {mongo.opcounters?.update ?? '-'} / {mongo.opcounters?.delete ?? '-'}
            </b></div>
            <div>运行时长：<b>
              {mongo.uptime_sec ? Math.floor(mongo.uptime_sec / 3600) + ' 小时' : '-'}
            </b></div>
          </div>
        </Card></Col>
      </Row>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { Avatar, Button } from 'antd'
import { ThinkState } from '../store'
import { convColor } from './ConvList'
import { t as i18nT, useLang } from '../i18n'

const TAIL_LINES = 8   // 收起态只显示最后几行（父页面保持轻量）

/**
 * think 消息气泡：Agent 思考流的流式展示（瞬态，不落库）。
 * 收起态只渲染尾部几行；展开态把全量文本交给 /think-view.html 的
 * iframe 渲染（sandbox 隔离，卡住也不影响聊天页），支持新窗口打开。
 */
export default function ThinkBubble({ t, onClose }: {
  t: ThinkState; onClose: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [frameReady, setFrameReady] = useState(false)
  useLang()
  useLang()
  const bodyRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const textRef = useRef(t.text)
  textRef.current = t.text

  // 收起态：内容更新时贴底
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [t.text])

  const sendToFrame = () => {
    // 显式同源 targetOrigin('/')而非通配符 '*':安全规范层面更稳;
    // 父页与 iframe 都是 /think-view.html,同源,行为完全一致,iPad Safari 无差异
    frameRef.current?.contentWindow
      ?.postMessage({ type: 'think', text: textRef.current }, '/')
  }

  // 展开态：文本变化 / iframe（重）加载完成时推送全量快照
  useEffect(() => {
    if (expanded && frameReady) sendToFrame()
  }, [expanded, frameReady, t.text])

  // iframe 就绪握手（无论时序如何都能补一发）
  useEffect(() => {
    if (!expanded) return
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'think-view-ready') sendToFrame()
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [expanded])

  const openInTab = () => {
    // 分享/回看模式：?id=GUID 由 think-view.html 调 API 拉快照（保留期内有效）；
    // 地址栏含 GUID，刷新即取服务端最新内容，链接可直接复制分享
    if (t.id) {
      window.open(`/think-view.html?id=${t.id}`, '_blank')
    } else {
      try {   // 兜底：无 GUID（理论上不会）
        sessionStorage.setItem('agentchat-think',
          JSON.stringify({ sender: t.sender, text: t.text }))
        window.open('/think-view.html', '_blank')
      } catch { /* 忽略 */ }
    }
  }

  return (
    <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
      <style>{`
        @keyframes thinkBlink { 0%,100%{opacity:.15} 50%{opacity:.9} }
        .think-dot { width:6px;height:6px;border-radius:50%;background:#faad14;
                     display:inline-block;animation:thinkBlink 1.2s infinite }
      `}</style>
      <Avatar style={{ background: convColor(t.sender), flexShrink: 0, opacity: 0.75 }}>
        {t.sender[0].toUpperCase()}
      </Avatar>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 2, display: 'flex',
                      alignItems: 'center', gap: 6 }}>
          <b style={{ color: '#666' }}>{t.sender}</b>
          <span>{t.done ? i18nT('msg.thought') : i18nT('msg.thinking')}</span>
          {!t.done && <span className="think-dot" />}
          <span style={{ marginLeft: 'auto', display: 'inline-flex' }}>
            <Button type="text" size="small" style={{ fontSize: 12 }}
                    onClick={() => { setExpanded(!expanded); setFrameReady(false) }}>
              {expanded ? i18nT('msg.collapse') : i18nT('msg.expand')}
            </Button>
            <Button type="text" size="small" style={{ fontSize: 12 }}
                    onClick={openInTab}>{i18nT('msg.newWindow')}</Button>
            <Button type="text" size="small" style={{ fontSize: 12 }}
                    onClick={onClose}>✕</Button>
          </span>
        </div>
        {expanded
          ? <iframe ref={frameRef} src="/think-view.html" title={`think-${t.sender}`}
                    sandbox="allow-scripts" onLoad={() => setFrameReady(true)}
                    style={{ width: '100%', height: 360, border: '1px solid #e8e8e8',
                             borderRadius: 8, background: '#fafafa' }} />
          : <div ref={bodyRef}
                 style={{ background: '#f6f6f6', border: '1px dashed #d9d9d9',
                          borderRadius: 8, padding: '6px 10px',
                          fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                          fontSize: 12, color: '#555', whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word', maxHeight: 132, overflowY: 'auto' }}>
              {t.text ? t.text.split('\n').slice(-TAIL_LINES).join('\n') : '…'}
            </div>}
      </div>
    </div>
  )
}

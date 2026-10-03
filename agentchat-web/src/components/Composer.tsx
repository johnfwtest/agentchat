import { useRef, useState } from 'react'
import { Alert, Button, Dropdown, Input, Popover, Progress, Spin, message } from 'antd'
import { PictureOutlined, PaperClipOutlined, SendOutlined,
         CloseOutlined, TeamOutlined, SmileOutlined, HistoryOutlined } from '@ant-design/icons'
import { sendMessage, uploadFile } from '../api'
import { useStore } from '../store'
import { t, useLang } from '../i18n'
import { useIsMobile } from '../responsive'
import { safeStorage } from '../safeStorage'

const EMOJI_GROUPS: { title: string; emojis: string[] }[] = [
  { title: t('emoji.tab1'), emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂',
                            '🙂', '😉', '😊', '😍', '😘', '😜', '🤔', '😏',
                            '😴', '😭', '😤', '😡', '🥺', '😱', '🤯', '🤗'] },
  { title: t('emoji.tab2'), emojis: ['👍', '👎', '👌', '✌️', '🙏', '💪', '🫡',
                                  '✅', '❌', '⏳', '⏰', '🔥', '💡', '⚠️',
                                  '❗', '❓', '💤', '🚀', '🐛', '📝'] },
  { title: t('emoji.tab3'), emojis: ['🎉', '🎊', '👏', '🎁', '🏆', '🥳', '☕',
                                  '🍕', '🍻', '📎', '📌', '🔗', '📊', '🛠️'] },
]

const H_KEY = 'agentchat_composer_h'   // 拖拽后的输入区高度（px），缺省自适应
const MIN_H = 120, MAX_VH = 0.75

export default function Composer() {
  const activeConvId = useStore(s => s.activeConvId)
  const replyTo = useStore(s => s.replyTo)
  const setReplyTo = useStore(s => s.setReplyTo)
  const convs = useStore(s => s.convs)
  const loadConvs = useStore(s => s.loadConvs)
  const me = useStore(s => s.me)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [prog, setProg] = useState<{ name: string; pct: number } | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  // 拖拽后的输入区高度(px,缺省自适应):走 safeStorage,iPad Safari 隐私模式
  // 不再让 setItem 抛错冒上来(会让拖拽后的 setH 后续更新失败)
  const [h, setH] = useState<number | null>(() => {
    const v = Number(safeStorage.get(H_KEY))
    return v >= MIN_H ? v : null
  })
  const [hoverHandle, setHoverHandle] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ y: number; h: number } | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const imgInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const isMobile = useIsMobile()
  useLang()
  const conv = convs.find(c => c.id === activeConvId)
  if (!activeConvId || !conv) return null

  const insertAtCursor = (snippet: string) => {
    const ta = taRef.current
    if (!ta) { setText(text + snippet); return }
    const start = ta.selectionStart ?? text.length
    const end = ta.selectionEnd ?? start
    setText(text.slice(0, start) + snippet + text.slice(end))
    requestAnimationFrame(() => {
      ta.focus()
      ta.selectionStart = ta.selectionEnd = start + snippet.length
    })
  }

  const doUpload = async (file: File, type: 'image' | 'file') => {
    setUploading(true)
    setUploadError(null)
    setProg({ name: file.name, pct: 0 })
    const placeholder = t('composer.uploadingFile').replace('{name}', file.name)
    insertAtCursor(placeholder)
    try {
      const r = await uploadFile(file, type,
        pct => setProg(p => (p ? { ...p, pct } : p)))
      setText(prev => prev.replace(placeholder, r.markdown))
      message.success(t('composer.uploadedFile').replace('{name}', r.filename))
    } catch (e: any) {
      setText(prev => prev.replace(placeholder, ''))   // 失败不留在草稿里，由红字提示
      setUploadError(t('composer.uploadFailedFile').replace('{name}', file.name).replace('{reason}', e.message || t('chat.uploadFailed')))
    } finally {
      setUploading(false)
      setProg(null)
    }
  }

  const send = async () => {
    const content = text.trim()
    if (!content || sending) return
    setSending(true)
    try {
      await sendMessage(activeConvId, content, replyTo?.seq)
      setText('')
      setReplyTo(null)
      await loadConvs()
    } catch (e: any) {
      message.error(e.message || t('composer.sendFailed'))
    } finally {
      setSending(false)
    }
  }

  const memberMenu = {
    items: [
      ...conv.members.filter(u => u !== me?.username)
        .map(u => ({ key: u, label: `@${u}` })),
      { key: 'all', label: t('composer.everyone') },
    ],
    onClick: ({ key }: { key: string }) => insertAtCursor(`@${key} `),
  }

  // ---- 输入区高度拖拽（上边界手柄：↕） ----
  const clampH = (v: number) =>
    Math.min(Math.max(v, MIN_H), Math.floor(window.innerHeight * MAX_VH))
  const onHandleDown = (e: React.PointerEvent) => {
    e.preventDefault()
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* 拖出窗口边界时无碍 */ }
    dragRef.current = { y: e.clientY, h: h ?? wrapRef.current?.offsetHeight ?? MIN_H }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'ns-resize'
  }
  const onHandleMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    const nh = clampH(dragRef.current.h + (dragRef.current.y - e.clientY))
    setH(nh)
    safeStorage.set(H_KEY, String(nh))
  }
  const onHandleUp = () => {
    if (!dragRef.current) return
    dragRef.current = null
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }
  const resetH = () => {
    setH(null)
    dragRef.current = null
    safeStorage.remove(H_KEY)
  }

  return (
    <div ref={wrapRef}
         style={{ borderTop: '1px solid #f0f0f0', padding: '8px 12px',
                  background: '#fff', height: h ?? undefined,
                  display: h ? 'flex' : undefined,
                  flexDirection: h ? 'column' : undefined }}>
      <div
        onPointerDown={onHandleDown} onPointerMove={onHandleMove}
        onPointerUp={onHandleUp} onPointerCancel={onHandleUp}
        onDoubleClick={resetH}
        onPointerEnter={() => setHoverHandle(true)}
        onPointerLeave={() => setHoverHandle(false)}
        title={t('composer.dragResize')}
        style={{ height: 8, margin: '-8px -12px 0', cursor: 'ns-resize',
                 display: 'flex', alignItems: 'center', justifyContent: 'center',
                 touchAction: 'none' }}>
        <div style={{ width: 40, height: 3, borderRadius: 2,
                      background: hoverHandle || dragRef.current ? '#8c8c8c' : '#d9d9d9' }} />
      </div>
      {/* 视频/音频走 type=image（![]() 嵌入语法），渲染层按扩展名显示为
          <video>/<audio>；仅放行 HTML 可直接播放的格式（.ogg 有音视频歧义，
          统一按视频渲染，浏览器 video 标签可播纯音频 ogg） */}
      <input ref={imgInput} type="file"
             accept="image/*,video/mp4,video/webm,video/ogg,audio/mpeg,audio/wav,audio/mp4,audio/flac,.mp4,.webm,.ogg,.mp3,.wav,.m4a,.flac" hidden
             onChange={e => { const f = e.target.files?.[0]
                              if (!f) return
                              if ((f.type.startsWith('video/') || f.type.startsWith('audio/')) &&
                                  !/\.(mp4|webm|ogg|mp3|wav|m4a|flac)$/i.test(f.name)) {
                                message.error(t('composer.mediaOnly'))
                                e.target.value = ''
                                return
                              }
                              doUpload(f, 'image'); e.target.value = '' }} />
      <input ref={fileInput} type="file" hidden
             onChange={e => { const f = e.target.files?.[0]
                              if (f) doUpload(f, 'file'); e.target.value = '' }} />

      {prog && (
        <div style={{ marginBottom: 6 }}>
          <Progress percent={prog.pct} size="small" status="active"
                    format={p => t('composer.uploadPct').replace('{p}', String(p))} />
          <div style={{ fontSize: 12, color: '#888', marginTop: -2,
                        overflow: 'hidden', whiteSpace: 'nowrap',
                        textOverflow: 'ellipsis' }}>
            {prog.name}
          </div>
        </div>
      )}
      {uploadError && (
        <Alert type="error" closable onClose={() => setUploadError(null)}
               style={{ marginBottom: 6 }} showIcon
               message={t('composer.uploadFailedLabel').replace('{msg}', uploadError)} />
      )}

      {replyTo && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4,
                      fontSize: 12, color: '#888', background: '#fafafa',
                      padding: '4px 8px', borderRadius: 6 }}>
          <span style={{ borderLeft: '2px solid #bbb', paddingLeft: 6, flex: 1,
                         overflow: 'hidden', whiteSpace: 'nowrap',
                         textOverflow: 'ellipsis' }}>
            {t('chat.replying')} <b>{replyTo.sender}</b>：{replyTo.content.slice(0, 60)}
          </span>
          <Button type="text" size="small" icon={<CloseOutlined />}
                  onClick={() => setReplyTo(null)} />
        </div>
      )}

      {/* 工具栏：桌面小按钮带文字；移动端仅图标（一行放不下时自动换行） */}
      <div style={{ display: 'flex', gap: isMobile ? 2 : 4, marginBottom: 6,
                    flexWrap: 'wrap', alignItems: 'center' }}>
        <Button size="small" type="text" icon={<PictureOutlined />} disabled={uploading}
                onClick={() => imgInput.current?.click()}
                title={t('composer.imageTitle')}>
          {isMobile ? '' : t('composer.image')}</Button>
        <Button size="small" type="text" icon={<PaperClipOutlined />} disabled={uploading}
                onClick={() => fileInput.current?.click()}
                title={t('composer.fileTitle')}>
          {isMobile ? '' : t('composer.file')}</Button>
        <Dropdown menu={memberMenu}>
          <Button size="small" type="text" title={t('composer.mention')}>@</Button>
        </Dropdown>
        <EmojiPicker onPick={insertAtCursor} small={isMobile} />
        <Button size="small" type="text" icon={<HistoryOutlined />} title={t('composer.historyTitle')}
                onClick={() => { location.hash = '#/history' }}>
          {isMobile ? '' : t('composer.history')}</Button>
        {uploading && <Spin size="small" style={{ marginLeft: 6 }} />}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end',
                    flex: h ? 1 : undefined, minHeight: h ? 0 : undefined }}>
        <Input.TextArea
          ref={taRef as any}
          value={text}
          onChange={e => setText(e.target.value)}
          onPressEnter={e => {
            if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={t('composer.placeholder')}
          autoSize={h ? false : { minRows: 2, maxRows: 8 }}
          style={h ? { flex: 1, height: '100%', resize: 'none' } : { flex: 1 }}
        />
        <Button type="primary" icon={<SendOutlined />} loading={sending}
                onClick={send} disabled={!text.trim()}>
          {t('composer.send')}
        </Button>
      </div>
    </div>
  )
}

function EmojiPicker({ onPick, small }: { onPick: (emoji: string) => void; small?: boolean }) {
  const [open, setOpen] = useState(false)
  const panel = (
    <div style={{ width: 264 }}>
      {EMOJI_GROUPS.map(g => (
        <div key={g.title} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>{g.title}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2 }}>
            {g.emojis.map(e => (
              <span key={e} onClick={() => onPick(e)}
                    style={{ fontSize: 18, textAlign: 'center', cursor: 'pointer',
                             padding: 2, borderRadius: 4, lineHeight: '26px' }}
                    onMouseEnter={ev => (ev.currentTarget.style.background = '#f0f0f0')}
                    onMouseLeave={ev => (ev.currentTarget.style.background = '')}>
                {e}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
  return (
    <Popover content={panel} trigger="click" open={open}
             onOpenChange={setOpen} placement="topLeft">
      <Button size="small" type="text" icon={<SmileOutlined />} title={t('composer.emojiTitle')}>
        {small ? '' : t('composer.emoji')}</Button>
    </Popover>
  )
}

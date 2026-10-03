import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useStore } from '../store'
import { t, useLang } from '../i18n'

// HTML 可直接播放的视频/音频扩展（与 Composer 上传白名单一致；
// .ogg 有音视频歧义，统一按视频渲染——浏览器 video 标签可播纯音频 ogg）
const VIDEO_RE = /\.(mp4|webm|ogg)(\?|#|$)/i
const AUDIO_RE = /\.(mp3|wav|m4a|flac)(\?|#|$)/i

/** 消息内媒体（无状态——弹框状态在全局 store 的 mediaViewer，见 MediaViewer.tsx）：
    图片/视频 → 点击打开全局查看器（放大/大屏播放，与消息流重渲染完全解耦，
    只有用户自己关闭）；音频 → 内联标准播放器。 */
function Media({ src, alt }: { src?: string; alt?: string }) {
  const openMediaViewer = useStore(s => s.openMediaViewer)
  useLang()
  if (!src) return null
  if (AUDIO_RE.test(src)) {
    return <audio src={src} controls preload="metadata"
                  title={alt || t('conv.audio')}
                  style={{ maxWidth: 320, verticalAlign: 'top' }} />
  }
  if (VIDEO_RE.test(src)) {
    return (
      <video src={src} preload="metadata" title={alt || t('conv.video')}
             onClick={() => openMediaViewer({ type: 'video', src, alt })}
             style={{ maxWidth: 320, maxHeight: 240, borderRadius: 6,
                      background: '#000', verticalAlign: 'top',
                      cursor: 'pointer', display: 'inline-block' }} />
    )
  }
  return (
    <img src={src} alt={alt || ''}
         onClick={() => openMediaViewer({ type: 'image', src, alt })}
         style={{ maxWidth: 320, borderRadius: 6, verticalAlign: 'top',
                  cursor: 'zoom-in', display: 'inline-block' }} />
  )
}

export default function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        img: props => <Media src={(props as any).src} alt={props.alt} />,
        a: props => (
          <a {...props} target="_blank" rel="noreferrer" />
        ),
        table: props => (
          <table className="md-table" style={{
            borderCollapse: 'collapse', fontSize: 13,
          }} {...props} />
        ),
        th: props => (
          <th style={{ border: '1px solid #e8e8e8', padding: '4px 8px',
                       background: '#fafafa' }} {...props} />
        ),
        td: props => (
          <td style={{ border: '1px solid #e8e8e8', padding: '4px 8px' }} {...props} />
        ),
        code: ({ className, children, ...rest }: any) => {
          const isBlock = /language-/.test(className || '') || String(children).includes('\n')
          if (isBlock) {
            return <code {...rest} className={className}
                     style={{ display: 'block', padding: 8, background: '#282c34',
                              color: '#abb2bf', borderRadius: 6, fontSize: 12,
                              overflowX: 'auto', whiteSpace: 'pre' }}>{children}</code>
          }
          return <code {...rest} style={{ background: '#f0f0f0', padding: '1px 5px',
                                          borderRadius: 4, fontSize: 13 }}>{children}</code>
        },
        p: props => <p style={{ marginBottom: 4, marginTop: 0 }} {...props} />,
        pre: props => <pre style={{ margin: 0 }} {...props} />,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

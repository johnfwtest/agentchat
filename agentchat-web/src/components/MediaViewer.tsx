import { Modal } from 'antd'
import { useStore } from '../store'

/** 全局媒体查看器（渲染在 App 顶层，与消息流重渲染完全解耦——
    消息区因 think/新消息刷新时不会关闭，只有用户自己关闭）。
    图片：大图展示；视频：大屏播放（controls）。 */
export default function MediaViewer() {
  const viewer = useStore(s => s.mediaViewer)
  const close = useStore(s => s.closeMediaViewer)
  if (!viewer) return null
  return (
    <Modal open onCancel={close} footer={null} destroyOnClose
           width="min(92vw, 1200px)"
           title={viewer.alt || (viewer.type === 'video' ? '视频' : '图片')}>
      {viewer.type === 'video' ? (
        <video src={viewer.src} controls autoPlay
               style={{ width: '100%', maxHeight: '75vh', background: '#000' }} />
      ) : (
        <img src={viewer.src} alt={viewer.alt || ''}
             style={{ maxWidth: '100%', maxHeight: '75vh', display: 'block',
                      margin: '0 auto' }} />
      )}
    </Modal>
  )
}

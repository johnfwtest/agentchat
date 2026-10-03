import { useEffect, useState } from 'react'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import { useStore, bootFromToken } from './store'
import { useAppHeight } from './useAppHeight'
import { useLang } from './i18n'
import Login from './pages/Login'
import Chat from './pages/Chat'
import Admin from './pages/Admin'
import History from './pages/History'
import MediaViewer from './components/MediaViewer'

export default function App() {
  const me = useStore(s => s.me)
  const [booted, setBooted] = useState(false)
  const [hash, setHash] = useState(location.hash)
  // iPad Safari 上 100vh 不准(把 URL 栏算进去,旋转/键盘弹出时跳动);
  // 在根挂一次,把 visualViewport 实时高度写到 --app-height,子组件用 var(--app-height)。
  useAppHeight()
  const lang = useLang()   // antd 组件文案（分页/日期等）随语言切换
  const antdLocale = lang === 'en' ? enUS : zhCN

  useEffect(() => {
    bootFromToken()
    setBooted(true)
    const onHash = () => setHash(location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (!booted || !me) return (
    <ConfigProvider locale={antdLocale}>
      <Login />
    </ConfigProvider>
  )

  const isAdminPage = hash === '#/admin'
  const isHistoryPage = hash === '#/history'
  return (
    <ConfigProvider locale={antdLocale}>
      {isAdminPage && me.role === 'admin' ? <Admin />
        : isHistoryPage ? <History />
        : <Chat />}
      <MediaViewer />
    </ConfigProvider>
  )
}

import { useEffect } from 'react'

/**
 * useAppHeight:把"实际可见视口高度"实时写到 :root 的 --app-height CSS 变量。
 *
 * 解决 iPad Safari 两个老问题:
 * 1. 100vh 把 URL 栏高度算进去,旋转 / 工具栏收起时整页跳一下
 * 2. iPad 接外接键盘或软键盘唤起时,可视区域变化但 100vh 不动 → 底部控件被遮
 *
 * 优先级:
 * - visualViewport.height:排除 URL 栏 / 工具栏的真实可视高度(最准)
 * - window.innerHeight:visualViewport 不可用时的兜底(老 Safari)
 *
 * 配合 CSS:var(--app-height, 100vh) —— 不支持 visualViewport 的老浏览器自动
 * 回退到 100vh,不会卡死布局。
 *
 * 使用方式:在应用根挂一次即可,所有子组件 height: var(--app-height)。
 */
export function useAppHeight() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const root = document.documentElement
    const apply = () => {
      const vv = window.visualViewport
      const h = vv ? vv.height : window.innerHeight
      // pixel 单位 ms 适配高分屏(iPad Retina)
      root.style.setProperty('--app-height', `${Math.round(h)}px`)
    }
    apply()
    // 旋转 / 工具栏收起展开:visualViewport.resize;浏览器窗口尺寸变化:window.resize
    window.visualViewport?.addEventListener('resize', apply)
    window.addEventListener('resize', apply)
    // 屏幕方向变化(部分旧 iPadOS Safari 只发 orientationchange)
    window.addEventListener('orientationchange', apply)
    return () => {
      window.visualViewport?.removeEventListener('resize', apply)
      window.removeEventListener('resize', apply)
      window.removeEventListener('orientationchange', apply)
    }
  }, [])
}
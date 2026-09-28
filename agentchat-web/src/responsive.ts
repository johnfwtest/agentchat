import { useEffect, useState } from 'react'

/** 移动端判定（<768px）：视口变化实时响应，用于布局切换与样式适配 */
export function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia(`(max-width: ${breakpoint}px)`).matches)
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const onChange = () => setIsMobile(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [breakpoint])
  return isMobile
}

/**
 * useIsTablet:独立的"平板"判定,与 useIsMobile 正交,二者各自维护。
 *
 * 用途:iPad / iPad mini / Android 平板需要一套与手机/桌面都不同的中间布局
 * (典型场景——两栏并列:列表 + 聊天;或桌面三栏的 Sider 默认折叠)。
 *
 * 阈值说明:
 * - 768 < width <= 1024 视为平板
 * - iPad mini 横屏(1024) / iPad 10/11 横屏(1080+) 不命中,继续走桌面布局
 * - iPad mini 竖屏(768) / iPad 10/11 竖屏(810/820/834/1024) 命中 → 平板布局
 *
 * 调用方根据产品意图自行决定:平板命中时走两栏、自适应三栏、还是单页切换。
 */
export function useIsTablet(min = 768, max = 1024) {
  const [isTablet, setIsTablet] = useState(() => {
    if (typeof window === 'undefined') return false
    const w = window.innerWidth
    return w > min && w <= max
  })
  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth
      setIsTablet(w > min && w <= max)
    }
    onResize()
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [min, max])
  return isTablet
}

import { useEffect, useReducer } from 'react'
import { zh } from './zh'
import { en } from './en'

/** 轻量 i18n：资源文件分开（i18n/zh.ts、i18n/en.ts…），新增语言 = 新增一份
 *  资源文件并在 LOCALES 注册，系统逻辑零改动。
 *  语言存 localStorage（登录页下拉选择，登录后全 UI 生效；消息内容不翻译）。 */

export type Lang = 'zh' | 'en'

const LANG_KEY = 'agentchat_lang'
const LOCALES: Record<Lang, Record<string, string>> = { zh, en }

let current: Lang = (localStorage.getItem(LANG_KEY) as Lang) || 'zh'
const listeners = new Set<() => void>()

export function getLang(): Lang { return current }

export function setLang(lang: Lang) {
  current = lang
  localStorage.setItem(LANG_KEY, lang)
  listeners.forEach(fn => fn())
}

/** 订阅语言变化的重渲染 hook（组件里调用一次即可） */
export function useLang(): Lang {
  const [, force] = useReducer(x => x + 1, 0)
  useEffect(() => {
    listeners.add(force)
    return () => { listeners.delete(force) }
  }, [])
  return current
}

/** 取文案；缺 key 回退中文，再缺返回 key 本身（便于发现遗漏） */
export function t(key: string): string {
  return LOCALES[current][key] ?? zh[key] ?? key
}

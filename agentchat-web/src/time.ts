/** 消息时间显示：今天 → HH:MM:SS；历史 → MM-DD HH:MM:SS（created_at 为 UTC ISO，
 *  本地时区判定"今天"）。 */
export function msgTime(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  const sameDay = d.toDateString() === new Date().toDateString()
  const hms = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return sameDay ? hms : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hms}`
}

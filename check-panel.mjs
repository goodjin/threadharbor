import { readFileSync } from 'node:fs'
import { findUiI18nViolations } from './packages/dsh-client/tests/ui-i18n-checker.ts'
const src = readFileSync('packages/dsh-client/src/panel.tsx', 'utf8')
const v = findUiI18nViolations('packages/dsh-client/src/panel.tsx', src)
console.log('total:', v.length)
// categorize by line content
const cats = { status: 0, timeago: 0, placeholder: 0, sentence: 0, other: 0 }
for (const x of v) {
  const s = x.snippet ?? ''
  if (/placeholder|那台机器|如：/.test(s)) cats.placeholder++
  else if (/刚刚|秒前|分钟前|小时前|天前/.test(s)) cats.timeago++
  else if (/在线|未连接|本机|状态/.test(s)) cats.status++
  else if (s.length > 30) cats.sentence++
  else cats.other++
}
console.log(JSON.stringify(cats, null, 2))
console.log('--- all snippets ---')
for (const x of v) console.log('L' + x.line, x.column, JSON.stringify(x.snippet))

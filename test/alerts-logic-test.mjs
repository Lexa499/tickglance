// TickGlance — alert-logic unit test (12 assertions).
//
// Pure logic only: imports src/alerts.ts directly (Node >= 22.6 strips the
// TypeScript types at load; no build step needed) and exercises arm/check/
// label behaviour for above / below / move alerts. This exact test passed
// 12/12 against the shipped v0.2.0 code during build week (2026-11-23).
//
// Run:  node test/alerts-logic-test.mjs
import { makeAboveAlert, makeBelowAlert, makeMoveAlert, checkAlert, alertLabel, movePctFromSet } from '../src/alerts.ts'
const fmt = (n) => '$' + n.toFixed(2)
let fails = 0
const t = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) fails++ }
const up = makeAboveAlert('BTC', 100, 1, 0)
t('above threshold = 101', up.threshold === 101)
t('above not fired at 100.99', !checkAlert(up, 100.99))
t('above fired at 101', checkAlert(up, 101))
const dn = makeBelowAlert('ETH', 200, 1, 0)
t('below threshold = 198', dn.threshold === 198)
t('below fired at 197.5', checkAlert(dn, 197.5))
t('below not fired at 199', !checkAlert(dn, 199))
const mv = makeMoveAlert('SOL', 80, 0.25, 0)
t('move not fired at +0.1%', !checkAlert(mv, 80.08))
t('move fired at +0.3%', checkAlert(mv, 80.24))
t('move fired at -0.3%', checkAlert(mv, 79.76))
t('label above', alertLabel(up, fmt) === '> $101.00')
t('label move', alertLabel(mv, fmt).startsWith('MOVE ±0.25%'))
t('movePctFromSet', Math.abs(movePctFromSet(mv, 88) - 10) < 1e-9)
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURES`)
process.exit(fails ? 1 : 0)

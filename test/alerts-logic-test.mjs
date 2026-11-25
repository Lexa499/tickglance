// TickGlance — alert-logic unit test (21 assertions).
//
// Pure logic only: imports src/alerts.ts directly (Node >= 22.6 strips the
// TypeScript types at load; no build step needed) and exercises arm/check/
// label behaviour for above / below / move alerts. The original 12 passed
// 12/12 against the shipped v0.2.0 code during build week (2026-11-23);
// 9 level-alert assertions were added for v0.3.0 (2026-11-26).
//
// Run:  node test/alerts-logic-test.mjs
import { makeAboveAlert, makeBelowAlert, makeMoveAlert, makeLevelAlert, levelStep, checkAlert, alertLabel, movePctFromSet } from '../src/alerts.ts'
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
t('level step BTC/ETH/SOL/DOGE', levelStep(59976) === 1000 && levelStep(1728) === 100 && levelStep(140) === 10 && Math.abs(levelStep(0.15) - 0.01) < 1e-12)
const lv = makeLevelAlert('BTC', 59976, 0)
t('level bounds 59000-60000', lv.threshold === 60000 && lv.levelDown === 59000)
t('level not fired mid-range', !checkAlert(lv, 59500))
t('level fired at upper bound', checkAlert(lv, 60000))
t('level fired at lower bound', checkAlert(lv, 59000))
t('level fired beyond bounds', checkAlert(lv, 61234) && checkAlert(lv, 58001))
const lvOn = makeLevelAlert('BTC', 60000, 0)
t('level armed ON a bound targets next out', lvOn.threshold === 61000 && lvOn.levelDown === 59000 && !checkAlert(lvOn, 60000))
const lvDoge = makeLevelAlert('DOGE', 0.154, 0)
t('level doge bounds', Math.abs(lvDoge.threshold - 0.16) < 1e-9 && Math.abs(lvDoge.levelDown - 0.15) < 1e-9)
t('label level', alertLabel(lv, fmt).startsWith('LVL $59000'))
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURES`)
process.exit(fails ? 1 : 0)

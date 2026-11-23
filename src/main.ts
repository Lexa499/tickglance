// TickGlance — glanceable crypto watchlist + price alerts for Even G2.
//
// A web app in the Even App WebView; talks to the glasses via the Even Hub
// SDK. Data is READ-ONLY public market data (Binance public data host
// only — Binance-only, Track 03; an earlier second-source fallback was
// removed 2026-11-19 per the track's listed-apps rule — see the README's
// pre-existing-code declaration). No API keys, no accounts, no funds.
// The only "write" actions are in-app state: arming/clearing price alerts,
// navigating, refreshing — all complete locally in under a second.
//
// Structure follows the official "Your First App" example
// (https://hub.evenrealities.com/docs/get-started/quickstart/first-app),
// with two field findings applied (feasibility spike + v1 simulator run,
// 2026-11-18, SDK 0.0.16 + simulator 0.9.5):
//
// 1. Temple clicks arrive as `sysEvent` with `eventType` MISSING (protobuf
//    omits the 0 = CLICK_EVENT default), not as the docs' `textEvent`.
//    Handlers route listEvent / textEvent / sysEvent and normalize a
//    missing eventType to CLICK.
// 2. Scroll (SCROLL_BOTTOM/TOP) is delivered reliably as `textEvent` on the
//    watchlist, but on a text-only detail page "down" inputs degraded
//    (first arrived as a bare sysEvent click, later ones were swallowed).
//    The detail action menu therefore uses a LIST container — the platform's
//    native menu widget: the OS owns focus/scroll and a selection arrives
//    as `listEvent` carrying `currentSelectItemIndex`. Non-list clicks on
//    the detail screen are logged and ignored, never guessed.
//
// Day 1 (build week, 2026-11-23): watchlist editing. A "+ Manage coins" row
// under the watchlist opens a MANAGE screen — again a native LIST container
// (one row per preset symbol, `[x]`/`[ ]` state in the label) where a tap
// toggles the symbol in/out of the watchlist. The watchlist persists in
// localStorage next to the alerts and survives restarts. Polish: watchlist
// rows are column-aligned, the armed-alert marker reads ` ALERT!`, and the
// detail header is 4 lines so the action list gets a taller viewport.
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import {
  checkAlert,
  makeAboveAlert,
  makeBelowAlert,
  makeMoveAlert,
  movePctFromSet,
  alertLabel,
  type PriceAlert,
} from './alerts'

// ---------------------------------------------------------------- data types

interface CoinDef {
  base: string // BTC
  binanceSymbol: string // BTCUSDT
}

interface CoinPrice {
  base: string
  price: number
  changePct: number
  high: number // Binance 24h high (always present — no fallback source)
  low: number
}

/** Fixed preset universe for watchlist editing. All are USDT pairs on the
 * Binance public data host. Which of these are shown (the watchlist) is
 * user state persisted in localStorage. */
const PRESET_COINS: CoinDef[] = [
  { base: 'BTC', binanceSymbol: 'BTCUSDT' },
  { base: 'ETH', binanceSymbol: 'ETHUSDT' },
  { base: 'SOL', binanceSymbol: 'SOLUSDT' },
  { base: 'BNB', binanceSymbol: 'BNBUSDT' },
  { base: 'XRP', binanceSymbol: 'XRPUSDT' },
  { base: 'DOGE', binanceSymbol: 'DOGEUSDT' },
  { base: 'ADA', binanceSymbol: 'ADAUSDT' },
  { base: 'LINK', binanceSymbol: 'LINKUSDT' },
]

const DEFAULT_WATCHLIST = ['BTC', 'ETH', 'SOL']
const WATCHLIST_KEY = 'tickglance.watchlist.v1'

let watchlist: string[] = loadWatchlist()

function loadWatchlist(): string[] {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY)
    if (!raw) return [...DEFAULT_WATCHLIST]
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return [...DEFAULT_WATCHLIST]
    const valid = parsed.filter(
      (b): b is string =>
        typeof b === 'string' && PRESET_COINS.some((c) => c.base === b),
    )
    const unique = [...new Set(valid)]
    return unique.length > 0 ? unique : [...DEFAULT_WATCHLIST]
  } catch {
    return [...DEFAULT_WATCHLIST]
  }
}

function saveWatchlist() {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist))
  } catch {
    /* in-memory only */
  }
}

/** Coin defs for the current watchlist, in watchlist order. */
function activeCoins(): CoinDef[] {
  return watchlist
    .map((b) => PRESET_COINS.find((c) => c.base === b))
    .filter((c): c is CoinDef => !!c)
}

function binanceUrl(): string {
  return (
    'https://data-api.binance.vision/api/v3/ticker/24hr?symbols=' +
    encodeURIComponent(JSON.stringify(activeCoins().map((c) => c.binanceSymbol)))
  )
}

const REFRESH_MS = 30_000
const ALERT_ABOVE_PCT = 1
const ALERT_BELOW_PCT = 1
const ALERT_MOVE_PCT = 0.25
const STORAGE_KEY = 'tickglance.alerts.v1'

// ---------------------------------------------------------------- state

type Screen = 'boot' | 'watch' | 'detail' | 'alert' | 'manage'

let screen: Screen = 'boot'
let prices: CoinPrice[] = []
let source: 'BINANCE' | null = null
let updatedAt: Date | null = null
let stale = false
let fetching = false
let watchCursor = 0
let fired: { alert: PriceAlert; price: number } | null = null

const alerts: Record<string, PriceAlert> = loadAlerts()

function loadAlerts(): Record<string, PriceAlert> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, PriceAlert>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {} // storage unavailable (e.g. some WebViews) — in-memory still works
  }
}

function saveAlerts() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts))
  } catch {
    /* in-memory only */
  }
}

// ---------------------------------------------------------------- formatting

function fmtPrice(n: number): string {
  const digits = n >= 1000 ? 0 : n >= 10 ? 2 : 3
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function fmtPct(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function fmtClock(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// ---------------------------------------------------------------- data layer

async function fetchBinance(): Promise<CoinPrice[]> {
  const res = await fetch(binanceUrl())
  if (!res.ok) throw new Error(`binance http ${res.status}`)
  const rows = (await res.json()) as Array<Record<string, string>>
  const bySymbol = new Map(rows.map((r) => [r.symbol, r]))
  const out: CoinPrice[] = []
  for (const c of activeCoins()) {
    const r = bySymbol.get(c.binanceSymbol)
    if (!r) throw new Error(`binance missing ${c.binanceSymbol}`)
    out.push({
      base: c.base,
      price: parseFloat(r.lastPrice),
      changePct: parseFloat(r.priceChangePercent),
      high: parseFloat(r.highPrice),
      low: parseFloat(r.lowPrice),
    })
  }
  return out
}

/** One refresh cycle: Binance only; on failure keep the last prices and
 * mark them STALE (no fallback source — Track 03 lists Binance only).
 * Re-checks alerts after a successful fetch. */
async function refresh(reason: string) {
  if (fetching) return
  fetching = true
  console.log(`[tickglance] refresh (${reason})`)
  try {
    prices = await fetchBinance()
    source = 'BINANCE'
    updatedAt = new Date()
    stale = false
    console.log(
      `[tickglance] prices source=${source} ` +
        prices.map((p) => `${p.base}=${p.price}`).join(' '),
    )
    checkAlerts()
  } catch (err) {
    stale = true
    console.log('[tickglance] refresh failed (binance only, keeping last prices):', String(err))
  } finally {
    fetching = false
    if (screen === 'boot') screen = 'watch'
    render()
  }
}

function checkAlerts() {
  for (const p of prices) {
    const a = alerts[p.base]
    if (a && checkAlert(a, p.price)) {
      console.log(
        `[tickglance] ALERT FIRED ${a.base} kind=${a.kind} set=${a.setPrice} now=${p.price}`,
      )
      delete alerts[p.base]
      saveAlerts()
      fired = { alert: a, price: p.price }
      screen = 'alert'
      return
    }
  }
}

// ---------------------------------------------------------------- rendering

const ACTIONS = ['Set alert +1%', 'Set alert -1%', 'Set move alert', 'Clear alert', 'Back'] as const

function selectedCoin(): CoinPrice | undefined {
  return prices[watchCursor]
}

function watchContent(): string {
  const head = `TICKGLANCE ${updatedAt ? fmtTime(updatedAt) : '--:--'}`
  const src = source ? `SRC ${source}` : 'NO DATA'
  const header = `${head}  ${src}${stale ? ' STALE' : ''}`
  if (prices.length === 0) {
    return [header, '', 'No prices yet.', '', 'hold: retry', '2tap:exit'].join('\n')
  }
  // Column-aligned rows (monospace display): base padded to 4, price
  // right-aligned in 9, pct right-aligned in 6 — prices line up vertically
  // so a glance compares them without scanning.
  const rows = prices.map((p, i) => {
    const cursor = i === watchCursor ? '>' : ' '
    const bell = alerts[p.base] ? ' ALERT!' : ''
    const price = fmtPrice(p.price).padStart(9)
    const pct = fmtPct(p.changePct).padStart(6)
    return `${cursor} ${p.base.padEnd(4)} ${price} ${pct}${bell}`
  })
  // The cursor can step one past the last coin onto the Manage row.
  const manageRow = `${watchCursor === prices.length ? '>' : ' '} + Manage coins`
  if (prices.length < 4) {
    // Spacious layout (default 3 coins): blanks + updated line + 2-line
    // footer = 10 lines at ~27 px pitch, fits the 288 px canvas.
    return [
      header,
      '',
      ...rows,
      manageRow,
      '',
      stale
        ? `STALE - updated ${updatedAt ? fmtClock(updatedAt) : '-'}`
        : `Updated ${updatedAt ? fmtClock(updatedAt) : '-'}`,
      'tap:open hold:refresh',
      '2tap:exit',
    ].join('\n')
  }
  // Compact layout for 4+ coins: no blanks, single-line footer (the header
  // already carries the update time). At 8 coins the footer is dropped so
  // every coin row + Manage stay on screen.
  const lines = [header, ...rows, manageRow]
  if (prices.length <= 7) lines.push('tap:open hold:refr 2tap:exit')
  return lines.join('\n')
}

function detailTextContent(): string {
  const p = selectedCoin()
  if (!p) return 'No data.\n\nhold: retry'
  const a = alerts[p.base]
  // 4 lines (price and 24h change merged) so the action list below gets a
  // taller viewport than v1's 5-line header allowed.
  return [
    `${p.base}/USDT  SRC ${source ?? '-'}`,
    `${fmtPrice(p.price)}  24h ${fmtPct(p.changePct)}`,
    `H ${fmtPrice(p.high)}  L ${fmtPrice(p.low)}`,
    a ? `ALERT: ${alertLabel(a, fmtPrice)}` : 'ALERT: none',
  ].join('\n')
}

function manageTextContent(): string {
  return [`MANAGE WATCHLIST (${watchlist.length} on)`, '[x]=on  tap: toggle'].join('\n')
}

/** Manage list rows: one per preset symbol with its on/off state, + Back. */
function manageItems(): string[] {
  const items = PRESET_COINS.map(
    (c) => `${watchlist.includes(c.base) ? '[x]' : '[ ]'} ${c.base}/USDT`,
  )
  items.push('Back')
  return items
}

function alertContent(): string {
  if (!fired) return 'No alert.'
  const { alert: a, price } = fired
  return [
    '!! PRICE ALERT !!',
    '',
    `${a.base}  ${alertLabel(a, fmtPrice)}`,
    `set at ${fmtPrice(a.setPrice)}`,
    `now ${fmtPrice(price)}  (${fmtPct(movePctFromSet(a, price))})`,
    '',
    'tap: OK',
  ].join('\n')
}

function currentTextContent(): string {
  switch (screen) {
    case 'boot':
      return 'TICKGLANCE\n\nLoading prices...'
    case 'watch':
      return watchContent()
    case 'detail':
      return detailTextContent()
    case 'alert':
      return alertContent()
    case 'manage':
      return manageTextContent()
  }
}

const bridge = await waitForEvenAppBridge()
let booted = false
let lastRenderedScreen: Screen | null = null

function textContainer(content: string, capture: number, height = 288, y = 0): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: y,
    width: 576,
    height,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: 1,
    containerName: 'main',
    content,
    isEventCapture: capture,
  })
}

function listContainer(
  name: string,
  items: string[],
  y: number,
  height: number,
): ListContainerProperty {
  return new ListContainerProperty({
    xPosition: 0,
    yPosition: y,
    width: 576,
    height,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: 2,
    containerName: name,
    itemContainer: new ListItemContainerProperty({
      itemCount: items.length,
      itemWidth: 560,
      isItemSelectBorderEn: 1,
      itemName: items,
    }),
    isEventCapture: 1,
  })
}

function actionListContainer(): ListContainerProperty {
  // Detail text is 4 lines now (~118 px), so the list viewport grows from
  // v1's 138 px to 170 px — a 4th action's label becomes visible.
  return listContainer('actions', [...ACTIONS], 118, 170)
}

function manageListContainer(): ListContainerProperty {
  // Manage header is 2 lines (~64 px) -> 224 px list: ~5 rows visible of 9,
  // the OS scrolls the rest.
  return listContainer('manage', manageItems(), 64, 224)
}

async function render() {
  const content = currentTextContent()
  if (!booted) {
    const result = await bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [textContainer(content, 1)],
      }),
    )
    if (result !== 0) {
      console.error('[tickglance] createStartUpPageContainer failed:', result)
      return
    }
    booted = true
    lastRenderedScreen = screen
    console.log('[tickglance] ready')
    return
  }
  if (screen !== lastRenderedScreen) {
    // Screen change -> full rebuild with that screen's container set.
    const ok =
      screen === 'detail'
        ? await bridge.rebuildPageContainer(
            new RebuildPageContainer({
              containerTotalNum: 2,
              textObject: [textContainer(content, 0, 118, 0)],
              listObject: [actionListContainer()],
            }),
          )
        : screen === 'manage'
          ? await bridge.rebuildPageContainer(
              new RebuildPageContainer({
                containerTotalNum: 2,
                textObject: [textContainer(content, 0, 64, 0)],
                listObject: [manageListContainer()],
              }),
            )
          : await bridge.rebuildPageContainer(
              new RebuildPageContainer({
                containerTotalNum: 1,
                textObject: [textContainer(content, 1)],
              }),
            )
    console.log(`[tickglance] rebuild screen=${screen} ok=${ok}`)
    if (ok) {
      lastRenderedScreen = screen
      return
    }
    // Fall through to a text upgrade if rebuild was rejected.
  }
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: 1, containerName: 'main', content }),
  )
  lastRenderedScreen = screen
}

/** Force the next render() to rebuild the page (needed when the current
 * screen's LIST items change in place, e.g. a watchlist toggle — a plain
 * text upgrade cannot change list item labels). */
function forceRebuild() {
  lastRenderedScreen = null
  void render()
}

// ---------------------------------------------------------------- actions

function openDetail() {
  if (prices.length === 0) return
  screen = 'detail'
  console.log(`[tickglance] screen=detail coin=${prices[watchCursor].base}`)
  void render()
}

function goWatch() {
  screen = 'watch'
  console.log('[tickglance] screen=watch')
  void render()
}

function openManage() {
  screen = 'manage'
  console.log(`[tickglance] screen=manage watchlist=${watchlist.join(',')}`)
  void render()
}

/** Manage-list selection: index PRESET_COINS.length is the Back row; any
 * other index toggles that preset symbol in/out of the watchlist. The
 * watchlist can never become empty. Removing a coin also disarms its
 * alert, so no orphan alert state survives. */
function toggleManageAt(index: number) {
  if (index === PRESET_COINS.length) {
    goWatch()
    return
  }
  const def = PRESET_COINS[index]
  if (!def) return
  const at = watchlist.indexOf(def.base)
  if (at >= 0) {
    if (watchlist.length <= 1) {
      console.log(`[tickglance] watchlist remove ${def.base} IGNORED (last coin)`)
      return
    }
    watchlist.splice(at, 1)
    if (alerts[def.base]) {
      delete alerts[def.base]
      saveAlerts()
    }
    console.log(`[tickglance] watchlist remove ${def.base} -> ${watchlist.join(',')}`)
  } else {
    watchlist.push(def.base)
    console.log(`[tickglance] watchlist add ${def.base} -> ${watchlist.join(',')}`)
  }
  saveWatchlist()
  watchCursor = 0
  forceRebuild()
  void refresh('watchlist-edit')
}

function exitApp() {
  console.log('[tickglance] exit requested')
  // Mode 1 = system exit-confirmation dialog; required on the root page
  // (silent mode 0 is rejected in QA).
  void bridge.shutDownPageContainer(1)
}

function executeActionAt(index: number) {
  const p = selectedCoin()
  if (!p) return
  const action = ACTIONS[index]
  if (!action) return
  const now = Date.now()
  switch (action) {
    case 'Set alert +1%': {
      const a = makeAboveAlert(p.base, p.price, ALERT_ABOVE_PCT, now)
      alerts[p.base] = a
      saveAlerts()
      console.log(`[tickglance] alert set ${p.base} above ${a.threshold}`)
      break
    }
    case 'Set alert -1%': {
      const a = makeBelowAlert(p.base, p.price, ALERT_BELOW_PCT, now)
      alerts[p.base] = a
      saveAlerts()
      console.log(`[tickglance] alert set ${p.base} below ${a.threshold}`)
      break
    }
    case 'Set move alert': {
      const a = makeMoveAlert(p.base, p.price, ALERT_MOVE_PCT, now)
      alerts[p.base] = a
      saveAlerts()
      console.log(`[tickglance] alert set ${p.base} move ±${ALERT_MOVE_PCT}% from ${a.setPrice}`)
      break
    }
    case 'Clear alert': {
      delete alerts[p.base]
      saveAlerts()
      console.log(`[tickglance] alert cleared ${p.base}`)
      break
    }
    case 'Back': {
      goWatch()
      return
    }
  }
  void render()
}

function moveWatchCursor(delta: number) {
  if (prices.length === 0) return
  // Cursor range includes one extra stop past the last coin: the Manage row.
  const stops = prices.length + 1
  watchCursor = (watchCursor + delta + stops) % stops
  const label = watchCursor === prices.length ? 'MANAGE' : prices[watchCursor].base
  console.log(`[tickglance] cursor watch=${watchCursor} coin=${label}`)
  void render()
}

function onClick() {
  if (screen === 'watch') {
    if (watchCursor >= prices.length) openManage()
    else openDetail()
  } else if (screen === 'alert') {
    fired = null
    goWatch()
  }
  // detail/manage: clicks are handled via listEvent (see event handler); a
  // bare click here carries no selection index and is never guessed.
}

function onDoubleClick() {
  if (screen === 'watch') exitApp()
  else if (screen === 'detail' || screen === 'manage') goWatch()
  else if (screen === 'alert') {
    fired = null
    goWatch()
  }
}

// ---------------------------------------------------------------- events

bridge.onEvenHubEvent((event) => {
  console.log('[tickglance] event', JSON.stringify(event.jsonData ?? event))

  // LIST channel first: on the detail screen the OS-owned list delivers the
  // selection (currentSelectItemIndex) — the only detail input we act on.
  const listEvent = event.listEvent
  if (listEvent) {
    const type = listEvent.eventType ?? OsEventTypeList.CLICK_EVENT
    console.log(
      `[tickglance] listEvent type=${type} index=${listEvent.currentSelectItemIndex} name=${listEvent.currentSelectItemName}`,
    )
    if (type === OsEventTypeList.CLICK_EVENT) {
      if (screen === 'detail') executeActionAt(listEvent.currentSelectItemIndex ?? 0)
      else if (screen === 'manage') toggleManageAt(listEvent.currentSelectItemIndex ?? 0)
    }
    return
  }

  // TEXT / SYS channels (findings in the header): missing eventType = CLICK.
  const channel = event.textEvent ?? event.sysEvent
  if (!channel) return
  const type = channel.eventType ?? OsEventTypeList.CLICK_EVENT

  if (screen === 'detail' || screen === 'manage') {
    // On detail/manage, only double-click (back) and long-press (refresh)
    // are acted on here; plain clicks/scrolls without a list index are
    // logged by the raw event line above and deliberately not guessed.
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) onDoubleClick()
    else if (type === OsEventTypeList.LONG_PRESS_EVENT) void refresh('long-press')
    return
  }

  switch (type) {
    case OsEventTypeList.CLICK_EVENT:
      onClick()
      return
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      onDoubleClick()
      return
    case OsEventTypeList.SCROLL_TOP_EVENT:
      if (screen === 'watch') moveWatchCursor(-1)
      return
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      if (screen === 'watch') moveWatchCursor(1)
      return
    case OsEventTypeList.LONG_PRESS_EVENT:
      void refresh('long-press')
      return
    default:
      // LONG_PRESS_RELEASE, foreground enter/exit, etc. — not used in v1.
      return
  }
})

// ---------------------------------------------------------------- boot

await render()
void refresh('boot')
setInterval(() => void refresh('auto'), REFRESH_MS)

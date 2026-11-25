// TickGlance — price alert logic (pure, unit-testable, no SDK imports).
//
// An alert is armed in-app state only: it moves no money, places no orders,
// and calls no trading endpoint. When a refresh sees the live price cross the
// armed condition, the app switches to the ALERT screen (a display state
// change) and the alert is disarmed (one-shot).

export type AlertKind = 'above' | 'below' | 'move' | 'level'

export interface PriceAlert {
  /** Coin base symbol, e.g. "BTC" */
  base: string
  kind: AlertKind
  /** For 'above'/'below': the price threshold. For 'move': the move percent (e.g. 0.25).
   * For 'level': the next round-number boundary ABOVE the set price. */
  threshold: number
  /** For 'level' only: the next round-number boundary BELOW the set price. */
  levelDown?: number
  /** Live price at the moment the alert was set. */
  setPrice: number
  /** Epoch ms when the alert was set. */
  setAt: number
}

/** Build an "price rises to >= current + pct%" alert. */
export function makeAboveAlert(base: string, currentPrice: number, pct: number, now: number): PriceAlert {
  return { base, kind: 'above', threshold: currentPrice * (1 + pct / 100), setPrice: currentPrice, setAt: now }
}

/** Build a "price falls to <= current - pct%" alert. */
export function makeBelowAlert(base: string, currentPrice: number, pct: number, now: number): PriceAlert {
  return { base, kind: 'below', threshold: currentPrice * (1 - pct / 100), setPrice: currentPrice, setAt: now }
}

/** Build a "price moves >= pct% in either direction from set price" alert. */
export function makeMoveAlert(base: string, currentPrice: number, pct: number, now: number): PriceAlert {
  return { base, kind: 'move', threshold: pct, setPrice: currentPrice, setAt: now }
}

/** Round-number step for a price: one order of magnitude below the price's
 * leading digit — BTC ~$59,976 -> $1,000; ETH ~$1,728 -> $100; SOL ~$140 ->
 * $10; DOGE ~$0.15 -> $0.01. Traders watch these round levels ("BTC at
 * 60k"), so a level alert fires when the price crosses one. */
export function levelStep(price: number): number {
  if (!(price > 0)) return 1
  return Math.pow(10, Math.floor(Math.log10(price)) - 1)
}

/** Round x to the nearest multiple of step, scrubbing float dust. */
function roundToStep(x: number, step: number): number {
  return Number((Math.round(x / step) * step).toFixed(8))
}

/** Build a "price crosses the next round level up or down" alert. The two
 * boundaries straddle the set price; arming exactly ON a boundary targets
 * the NEXT boundary out on both sides, so it never fires instantly. */
export function makeLevelAlert(base: string, currentPrice: number, now: number): PriceAlert {
  const step = levelStep(currentPrice)
  let up = roundToStep((Math.floor(currentPrice / step) + 1) * step, step)
  let down = roundToStep(Math.floor(currentPrice / step) * step, step)
  if (down >= currentPrice) down = roundToStep(currentPrice - step, step)
  if (up <= currentPrice) up = roundToStep(currentPrice + step, step)
  return { base, kind: 'level', threshold: up, levelDown: down, setPrice: currentPrice, setAt: now }
}

/** True when the live price satisfies the armed alert condition. */
export function checkAlert(alert: PriceAlert, price: number): boolean {
  switch (alert.kind) {
    case 'above':
      return price >= alert.threshold
    case 'below':
      return price <= alert.threshold
    case 'move': {
      if (alert.setPrice <= 0) return false
      const movePct = Math.abs((price - alert.setPrice) / alert.setPrice) * 100
      return movePct >= alert.threshold
    }
    case 'level':
      return price >= alert.threshold || (alert.levelDown != null && price <= alert.levelDown)
  }
}

/** Signed percent move from the set price to the given price (for the fired screen). */
export function movePctFromSet(alert: PriceAlert, price: number): number {
  if (alert.setPrice <= 0) return 0
  return ((price - alert.setPrice) / alert.setPrice) * 100
}

/** Short human label, e.g. "> $64,892" / "< $63,607" / "MOVE ±0.25%". fmt formats a price. */
export function alertLabel(alert: PriceAlert, fmt: (n: number) => string): string {
  switch (alert.kind) {
    case 'above':
      return `> ${fmt(alert.threshold)}`
    case 'below':
      return `< ${fmt(alert.threshold)}`
    case 'move':
      return `MOVE ±${alert.threshold}% from ${fmt(alert.setPrice)}`
    case 'level':
      return `LVL ${alert.levelDown != null ? fmt(alert.levelDown) : '?'} - ${fmt(alert.threshold)}`
  }
}

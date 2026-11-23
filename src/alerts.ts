// TickGlance — price alert logic (pure, unit-testable, no SDK imports).
//
// An alert is armed in-app state only: it moves no money, places no orders,
// and calls no trading endpoint. When a refresh sees the live price cross the
// armed condition, the app switches to the ALERT screen (a display state
// change) and the alert is disarmed (one-shot).

export type AlertKind = 'above' | 'below' | 'move'

export interface PriceAlert {
  /** Coin base symbol, e.g. "BTC" */
  base: string
  kind: AlertKind
  /** For 'above'/'below': the price threshold. For 'move': the move percent (e.g. 0.25). */
  threshold: number
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
  }
}

// Forecasting and risk engine — transparent, explainable rules (no black box).
import { commodities, facilities, forecastSeason, seasonIndex, type StockRecord } from './data'

export type Risk = 'critical' | 'high' | 'watch' | 'ok' | 'overstock'

export type Assessment = {
  facilityId: string
  facilityName: string
  county: string
  level: string
  commodityId: string
  commodityName: string
  unit: string
  stockOnHand: number
  amc: number // average monthly consumption, last 3 months
  forecast: number[] // next 3 months
  monthsOfStock: number // stock on hand ÷ forecast demand
  leadTimeMonths: number
  stockoutInDays: number | null
  risk: Risk
  trendPct: number // change of recent 3 months vs previous 3
  history: number[]
}

export type Transfer = {
  commodityId: string
  commodityName: string
  unit: string
  from: string
  to: string
  county: string
  quantity: number
  toMonthsAfter: number
  fromMonthsAfter: number
}

const round1 = (n: number) => Math.round(n * 10) / 10

// Holt's linear exponential smoothing on de-seasonalised demand, then re-seasonalised
export function forecastDemand(history: number[], seasonal: boolean, horizon = 3): number[] {
  const series = seasonal ? history.map((v, i) => v / seasonIndex[i]) : history
  const alpha = 0.5
  const beta = 0.3
  let level = series[0]
  let trend = series[1] - series[0]
  for (let i = 1; i < series.length; i++) {
    const prevLevel = level
    level = alpha * series[i] + (1 - alpha) * (level + trend)
    trend = beta * (level - prevLevel) + (1 - beta) * trend
  }
  return Array.from({ length: horizon }, (_, h) => {
    const base = Math.max(0, level + trend * (h + 1))
    return Math.round(seasonal ? base * forecastSeason[h] : base)
  })
}

// Walk forward month by month to find when stock runs out
function daysToStockout(stock: number, forecast: number[]): number | null {
  let remaining = stock
  for (let m = 0; m < forecast.length; m++) {
    const need = forecast[m]
    if (need <= 0) continue
    if (remaining < need) return Math.round((m + remaining / need) * 30)
    remaining -= need
  }
  return null // lasts beyond the forecast horizon
}

export function classify(mos: number, lead: number): Risk {
  if (mos < lead) return 'critical' // runs out before a normal order can arrive
  if (mos < lead + 0.5) return 'high'
  if (mos < 2.5) return 'watch'
  if (mos > 6) return 'overstock'
  return 'ok'
}

export function assess(records: StockRecord[]): Assessment[] {
  return records.map((r) => {
    const f = facilities.find((x) => x.id === r.facilityId)!
    const c = commodities.find((x) => x.id === r.commodityId)!
    const forecast = forecastDemand(r.history, c.seasonal)
    const avgForecast = forecast.reduce((a, b) => a + b, 0) / forecast.length
    const mos = avgForecast > 0 ? r.stockOnHand / avgForecast : 99
    const recent = r.history.slice(-3).reduce((a, b) => a + b, 0)
    // Compare quarters after removing seasonality, so the end of the rainy season isn't read as a fall
    const adj = c.seasonal ? r.history.map((v, i) => v / seasonIndex[i]) : r.history
    const recentAdj = adj.slice(-3).reduce((a, b) => a + b, 0)
    const prior = adj.slice(-6, -3).reduce((a, b) => a + b, 0)
    return {
      facilityId: f.id,
      facilityName: f.name,
      county: f.county,
      level: f.level,
      commodityId: c.id,
      commodityName: c.name,
      unit: c.unit,
      stockOnHand: r.stockOnHand,
      amc: Math.round(recent / 3),
      forecast,
      monthsOfStock: round1(mos),
      leadTimeMonths: f.leadTimeMonths,
      stockoutInDays: daysToStockout(r.stockOnHand, forecast),
      risk: classify(mos, f.leadTimeMonths),
      trendPct: prior > 0 ? Math.round(((recentAdj - prior) / prior) * 100) : 0,
      history: r.history,
    }
  })
}

// Suggest moving surplus within the same county: lift the at-risk facility to
// its lead time + 1 month of stock, never leaving the donor below 3 months.
export function suggestTransfers(items: Assessment[]): Transfer[] {
  const transfers: Transfer[] = []
  const pool = new Map(items.map((a) => [`${a.facilityId}:${a.commodityId}`, a.stockOnHand]))
  const atRisk = items
    .filter((a) => a.risk === 'critical' || a.risk === 'high')
    .sort((a, b) => a.monthsOfStock - b.monthsOfStock)

  for (const need of atRisk) {
    const demand = need.forecast.reduce((a, b) => a + b, 0) / need.forecast.length
    const target = Math.ceil(demand * (need.leadTimeMonths + 1))
    let gap = target - (pool.get(`${need.facilityId}:${need.commodityId}`) ?? 0)
    const donors = items
      .filter((d) => d.commodityId === need.commodityId && d.county === need.county && d.facilityId !== need.facilityId)
      .map((d) => {
        const dDemand = d.forecast.reduce((a, b) => a + b, 0) / d.forecast.length
        const stock = pool.get(`${d.facilityId}:${d.commodityId}`) ?? 0
        return { d, dDemand, spare: Math.floor(stock - dDemand * 3) }
      })
      .filter((x) => x.spare > 0)
      .sort((a, b) => b.spare - a.spare)

    for (const { d, dDemand, spare } of donors) {
      if (gap <= 0) break
      const qty = Math.min(gap, spare)
      if (qty < Math.max(10, demand * 0.25)) continue // too small to justify a trip
      const toKey = `${need.facilityId}:${need.commodityId}`
      const fromKey = `${d.facilityId}:${d.commodityId}`
      pool.set(toKey, (pool.get(toKey) ?? 0) + qty)
      pool.set(fromKey, (pool.get(fromKey) ?? 0) - qty)
      transfers.push({
        commodityId: need.commodityId,
        commodityName: need.commodityName,
        unit: need.unit,
        from: d.facilityName,
        to: need.facilityName,
        county: need.county,
        quantity: qty,
        toMonthsAfter: round1((pool.get(toKey) ?? 0) / demand),
        fromMonthsAfter: round1((pool.get(fromKey) ?? 0) / dDemand),
      })
      gap -= qty
    }
  }
  return transfers
}

export const riskOrder: Record<Risk, number> = { critical: 0, high: 1, watch: 2, overstock: 3, ok: 4 }

// Plain-language summary used when the AI assistant is unavailable (and as its factual basis)
export function ruleSummary(a: Assessment, transfers: Transfer[]): string {
  const t = transfers.filter((x) => x.to === a.facilityName && x.commodityId === a.commodityId)
  const when = a.stockoutInDays !== null ? `in about ${a.stockoutInDays} days` : 'beyond the next three months'
  const lines = [
    `${a.facilityName} (${a.county}) holds ${a.stockOnHand} ${a.unit} of ${a.commodityName}, about ${a.monthsOfStock} months of stock against forecast demand.`,
    `At the forecast rate it would run out ${when}; a normal resupply takes ${a.leadTimeMonths} ${a.leadTimeMonths === 1 ? 'month' : 'months'}.`,
  ]
  if (a.trendPct !== 0) lines.push(`Underlying consumption is ${a.trendPct > 0 ? 'up' : 'down'} ${Math.abs(a.trendPct)}% on the previous quarter.`)
  if (t.length) lines.push(`Suggested: transfer ${t.map((x) => `${x.quantity} ${x.unit} from ${x.from}`).join(' and ')}.`)
  else if (a.risk === 'critical' || a.risk === 'high') lines.push('No surplus found within the county — escalate an emergency order.')
  return lines.join(' ')
}

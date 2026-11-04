// SYNTHETIC DATA — generated for demonstration. No real facility or patient data.
// Shapes mirror what a county would pull from KHIS / LMIS reports:
// monthly consumption, stock on hand, and resupply lead time per facility and commodity.

export type Commodity = {
  id: string
  name: string
  unit: string
  seasonal: boolean // malaria-linked items peak in the long rains
}

export type Facility = {
  id: string
  name: string
  county: string
  level: 'Dispensary' | 'Health Centre' | 'Sub-County Hospital'
  leadTimeMonths: number
}

export type StockRecord = {
  facilityId: string
  commodityId: string
  history: number[] // last 12 months of consumption, oldest first
  stockOnHand: number
}

export const commodities: Commodity[] = [
  { id: 'al', name: 'Artemether-lumefantrine 20/120 (AL 6×4)', unit: 'packs', seasonal: true },
  { id: 'amox', name: 'Amoxicillin DT 250 mg', unit: 'packs', seasonal: false },
  { id: 'ors', name: 'ORS / zinc co-pack', unit: 'packs', seasonal: false },
  { id: 'oxy', name: 'Oxytocin 10 IU injection', unit: 'ampoules', seasonal: false },
  { id: 'tld', name: 'TLD (TDF/3TC/DTG) 30s', unit: 'bottles', seasonal: false },
  { id: 'dmpa', name: 'DMPA-SC contraceptive', unit: 'vials', seasonal: false },
]

export const facilities: Facility[] = [
  { id: 'K-01', name: 'Facility K-01', county: 'Kericho', level: 'Sub-County Hospital', leadTimeMonths: 1 },
  { id: 'K-02', name: 'Facility K-02', county: 'Kericho', level: 'Health Centre', leadTimeMonths: 1.5 },
  { id: 'K-03', name: 'Facility K-03', county: 'Kericho', level: 'Dispensary', leadTimeMonths: 2 },
  { id: 'K-04', name: 'Facility K-04', county: 'Kericho', level: 'Dispensary', leadTimeMonths: 2 },
  { id: 'B-01', name: 'Facility B-01', county: 'Bomet', level: 'Sub-County Hospital', leadTimeMonths: 1 },
  { id: 'B-02', name: 'Facility B-02', county: 'Bomet', level: 'Health Centre', leadTimeMonths: 1.5 },
  { id: 'B-03', name: 'Facility B-03', county: 'Bomet', level: 'Dispensary', leadTimeMonths: 2 },
  { id: 'N-01', name: 'Facility N-01', county: 'Nandi', level: 'Sub-County Hospital', leadTimeMonths: 1 },
  { id: 'N-02', name: 'Facility N-02', county: 'Nandi', level: 'Health Centre', leadTimeMonths: 1.5 },
  { id: 'N-03', name: 'Facility N-03', county: 'Nandi', level: 'Dispensary', leadTimeMonths: 2 },
]

// The 12 reporting months, oldest first (Nov 2025 – Oct 2026)
export const months = ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']

// Malaria seasonality index by calendar month (long rains Apr–Jun peak), Nov..Oct order,
// then continuing Nov, Dec, Jan for the forecast horizon.
export const seasonIndex = [1.0, 0.95, 0.85, 0.8, 0.95, 1.25, 1.4, 1.3, 1.05, 0.95, 0.9, 0.95]
export const forecastSeason = [1.0, 0.95, 0.85]

// Deterministic pseudo-random generator so the demo is identical on every load
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const levelScale = { Dispensary: 1, 'Health Centre': 2.2, 'Sub-County Hospital': 5 }
const baseDemand: Record<string, number> = { al: 40, amox: 55, ors: 30, oxy: 25, tld: 60, dmpa: 35 }

// A few scripted situations so the demo shows every risk level clearly
const scenarios: Record<string, { trend?: number; stockMonths?: number; lastMonthSpike?: number }> = {
  'K-03:al': { trend: 0.06, stockMonths: 0.6 }, // rising malaria cases, low stock → critical
  'K-04:al': { stockMonths: 5.5 }, // nearby surplus of AL
  'B-02:tld': { trend: 0.04, stockMonths: 1.2 }, // ART enrolment growing → high
  'B-01:tld': { stockMonths: 6.5 }, // surplus at sub-county hospital
  'N-03:oxy': { stockMonths: 0.4 }, // maternal health risk → critical
  'N-01:oxy': { stockMonths: 4.8 },
  'K-02:amox': { stockMonths: 1.8 }, // watch
  'N-02:dmpa': { stockMonths: 2.1 },
  'B-03:ors': { stockMonths: 9 }, // overstock / expiry risk
  'B-02:ors': { lastMonthSpike: 2.7 }, // sudden diarrhoeal-disease signal
  'N-02:amox': { lastMonthSpike: 2.3 }, // unexplained jump: outbreak or diversion?
}

export function buildStock(): StockRecord[] {
  const rand = mulberry32(20261104)
  const records: StockRecord[] = []
  for (const f of facilities) {
    for (const c of commodities) {
      const key = `${f.id}:${c.id}`
      const sc = scenarios[key] ?? {}
      const base = baseDemand[c.id] * levelScale[f.level] * (0.85 + rand() * 0.3)
      const trend = sc.trend ?? (rand() - 0.5) * 0.02
      const history = months.map((_, m) => {
        const season = c.seasonal ? seasonIndex[m] : 1
        const noise = 0.9 + rand() * 0.2
        const spike = m === months.length - 1 && sc.lastMonthSpike ? sc.lastMonthSpike : 1
        return Math.max(1, Math.round(base * season * (1 + trend * m) * noise * spike))
      })
      const recent = history.slice(-3).reduce((a, b) => a + b, 0) / 3
      const stockMonths = sc.stockMonths ?? 2.5 + rand() * 2.5
      records.push({ facilityId: f.id, commodityId: c.id, history, stockOnHand: Math.round(recent * stockMonths) })
    }
  }
  return records
}

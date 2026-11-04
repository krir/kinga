import { useMemo, useState } from 'react'
import { buildStock, commodities, months } from './data'
import { assess, riskOrder, ruleSummary, suggestTransfers, type Assessment, type Risk } from './engine'

const riskLabel: Record<Risk, string> = {
  critical: 'Critical',
  high: 'High',
  watch: 'Watch',
  ok: 'OK',
  overstock: 'Overstock',
}

const counties = ['All counties', 'Kericho', 'Bomet', 'Nandi']

function Sparkline({ a }: { a: Assessment }) {
  const all = [...a.history, ...a.forecast]
  const max = Math.max(...all) * 1.1
  const w = 420
  const h = 110
  const step = w / (all.length - 1)
  const y = (v: number) => h - (v / max) * h
  const pts = (arr: number[], offset = 0) => arr.map((v, i) => `${(i + offset) * step},${y(v)}`).join(' ')
  const hist = pts(a.history)
  const fc = pts([a.history[a.history.length - 1], ...a.forecast], a.history.length - 1)
  return (
    <svg className="spark" viewBox={`-6 -8 ${w + 12} ${h + 30}`} role="img" aria-label="Consumption history and three-month forecast">
      <line className="spark-grid" x1="0" y1={h} x2={w} y2={h} />
      <line className="spark-split" x1={(a.history.length - 1) * step} y1="0" x2={(a.history.length - 1) * step} y2={h} />
      <polyline className="spark-hist" points={hist} />
      <polyline className="spark-fc" points={fc} />
      {a.forecast.map((v, i) => (
        <circle key={i} className="spark-dot" cx={(a.history.length + i) * step} cy={y(v)} r="3.5" />
      ))}
      <text className="spark-label" x="0" y={h + 20}>{months[0]}</text>
      <text className="spark-label" x={(a.history.length - 1) * step} y={h + 20} textAnchor="middle">{months[11]}</text>
      <text className="spark-label" x={w} y={h + 20} textAnchor="end">forecast →</text>
    </svg>
  )
}

export default function App() {
  const items = useMemo(() => assess(buildStock()), [])
  const transfers = useMemo(() => suggestTransfers(items), [items])
  const [county, setCounty] = useState('All counties')
  const [commodity, setCommodity] = useState('all')
  const [showAll, setShowAll] = useState(false)
  const [selected, setSelected] = useState<Assessment | null>(
    () => items.filter((a) => a.risk === 'critical').sort((a, b) => a.monthsOfStock - b.monthsOfStock)[0] ?? null,
  )
  const [ai, setAi] = useState<{ state: 'idle' | 'loading' | 'done' | 'fallback'; text: string }>({ state: 'idle', text: '' })

  const filtered = items
    .filter((a) => county === 'All counties' || a.county === county)
    .filter((a) => commodity === 'all' || a.commodityId === commodity)
    .filter((a) => showAll || a.risk !== 'ok')
    .sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk] || a.monthsOfStock - b.monthsOfStock)

  const scope = items.filter((a) => county === 'All counties' || a.county === county)
  const count = (r: Risk) => scope.filter((a) => a.risk === r).length
  const scopeTransfers = transfers.filter((t) => county === 'All counties' || t.county === county)

  function select(a: Assessment) {
    setSelected(a)
    setAi({ state: 'idle', text: '' })
  }

  async function explain(a: Assessment) {
    setAi({ state: 'loading', text: '' })
    const facts = {
      facility: a.facilityName,
      county: a.county,
      level: a.level,
      commodity: a.commodityName,
      unit: a.unit,
      stockOnHand: a.stockOnHand,
      amc: a.amc,
      forecast: a.forecast,
      monthsOfStock: a.monthsOfStock,
      leadTimeMonths: a.leadTimeMonths,
      stockoutInDays: a.stockoutInDays,
      risk: a.risk,
      trendPct: a.trendPct,
      transfers: transfers
        .filter((t) => t.to === a.facilityName && t.commodityId === a.commodityId)
        .map((t) => ({ from: t.from, quantity: t.quantity, fromMonthsAfter: t.fromMonthsAfter })),
    }
    try {
      const res = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(facts),
      })
      const data = (await res.json()) as { text?: string }
      if (!res.ok || !data.text) throw new Error('no text')
      setAi({ state: 'done', text: data.text })
    } catch {
      setAi({ state: 'fallback', text: ruleSummary(a, transfers) })
    }
  }

  const selTransfers = selected
    ? transfers.filter((t) => t.to === selected.facilityName && t.commodityId === selected.commodityId)
    : []

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden="true">+</span>
          <div>
            <h1>Kinga</h1>
            <p>Essential-medicine stock-out early warning</p>
          </div>
        </div>
        <p className="synthetic">Prototype · synthetic data · {items.length} facility–medicine pairs across 3 counties</p>
      </header>

      <section className="tiles" aria-label="Summary">
        <div className="tile t-critical"><strong>{count('critical')}</strong><span>Critical: runs out before resupply can arrive</span></div>
        <div className="tile t-high"><strong>{count('high')}</strong><span>High: less than half a month of buffer</span></div>
        <div className="tile t-watch"><strong>{count('watch')}</strong><span>Watch: under 2.5 months of stock</span></div>
        <div className="tile t-over"><strong>{count('overstock')}</strong><span>Overstock: over 6 months, expiry risk</span></div>
        <div className="tile t-move"><strong>{scopeTransfers.length}</strong><span>Suggested transfers within county</span></div>
      </section>

      <section className="filters" aria-label="Filters">
        <label>
          County
          <select id="county" value={county} onChange={(e) => setCounty(e.target.value)}>
            {counties.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label>
          Medicine
          <select id="commodity" value={commodity} onChange={(e) => setCommodity(e.target.value)}>
            <option value="all">All tracer medicines</option>
            {commodities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="check">
          <input id="showall" type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show items with no risk
        </label>
      </section>

      <main className="grid">
        <section className="panel table-panel" aria-label="Risk list">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Risk</th><th>Facility</th><th className="d-only">Medicine</th>
                  <th className="num">Stock</th><th className="num">Months left</th><th className="num">Runs out</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => {
                  const key = `${a.facilityId}:${a.commodityId}`
                  const active = selected && `${selected.facilityId}:${selected.commodityId}` === key
                  return (
                    <tr key={key} className={active ? 'active' : ''} onClick={() => select(a)} tabIndex={0}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && select(a)}>
                      <td><span className={`chip c-${a.risk}`}>{riskLabel[a.risk]}</span></td>
                      <td>{a.facilityName}<small>{a.county} · {a.level}</small><small className="m-only">{a.commodityName}</small></td>
                      <td className="d-only">{a.commodityName}</td>
                      <td className="num">{a.stockOnHand.toLocaleString()}</td>
                      <td className="num">{a.monthsOfStock}</td>
                      <td className="num">{a.stockoutInDays !== null ? `${a.stockoutInDays} d` : '90 d +'}</td>
                    </tr>
                  )
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={6} className="empty">No items at risk for this filter. Tick “Show items with no risk” to see everything.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="panel detail" aria-label="Details">
          {selected ? (
            <>
              <span className={`chip c-${selected.risk}`}>{riskLabel[selected.risk]}</span>
              <h2>{selected.commodityName}</h2>
              <p className="where">{selected.facilityName} · {selected.county} · {selected.level}</p>

              <dl className="facts">
                <div><dt>Stock on hand</dt><dd>{selected.stockOnHand} {selected.unit}</dd></div>
                <div><dt>Avg monthly use</dt><dd>{selected.amc}</dd></div>
                <div><dt>Months of stock</dt><dd>{selected.monthsOfStock}</dd></div>
                <div><dt>Resupply lead time</dt><dd>{selected.leadTimeMonths} mo</dd></div>
                <div><dt>Projected stock-out</dt><dd>{selected.stockoutInDays !== null ? `~${selected.stockoutInDays} days` : 'beyond 90 days'}</dd></div>
                <div><dt>Underlying trend</dt><dd>{selected.trendPct > 0 ? '+' : ''}{selected.trendPct}%</dd></div>
              </dl>

              <h3>Consumption and forecast</h3>
              <Sparkline a={selected} />
              <p className="note">12 months of reported use, then a 3-month forecast (Holt smoothing, seasonally adjusted for malaria medicines).</p>

              <h3>Suggested redistribution</h3>
              {selTransfers.length ? (
                <ul className="moves">
                  {selTransfers.map((t) => (
                    <li key={t.from}>
                      Move <strong>{t.quantity} {t.unit}</strong> from {t.from}
                      <small>{t.from} keeps {t.fromMonthsAfter} months · {t.to} reaches {t.toMonthsAfter} months</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="note">
                  {selected.risk === 'critical' || selected.risk === 'high'
                    ? 'No surplus within the county. Raise an emergency order.'
                    : 'No action needed.'}
                </p>
              )}

              <h3>Assistant</h3>
              <button className="ai-btn" onClick={() => explain(selected)} disabled={ai.state === 'loading'}>
                {ai.state === 'loading' ? 'Explaining…' : 'Explain this for the county pharmacist'}
              </button>
              {(ai.state === 'done' || ai.state === 'fallback') && (
                <div className="ai-out">
                  <p className="ai-tag">
                    {ai.state === 'done' ? 'AI-generated from the figures above · check before acting' : 'Rule-based summary (AI assistant runs on the deployed version)'}
                  </p>
                  <p>{ai.text}</p>
                </div>
              )}
            </>
          ) : (
            <p className="note">Select a row to see details.</p>
          )}
        </aside>
      </main>

      <footer className="foot">
        <p>
          <strong>How it works.</strong> Months of stock = stock on hand ÷ forecast demand. An item is critical when it would
          run out before a normal resupply can arrive. Transfers move surplus within a county, never leaving a donor below
          three months. The assistant only explains computed figures; people make the decisions.
        </p>
        <p>Synthetic data for demonstration · Built by Kennedy Korir</p>
      </footer>
    </div>
  )
}

// Kinga Worker: serves the dashboard, an open read-only API, and one grounded AI endpoint.
// Every figure and action in an explanation comes from Kinga's rules. The AI writes only a short
// note on why it matters for patients, and that note is checked before it is used.
import { buildStock } from '../src/data'
import { assess, suggestTransfers } from '../src/engine'

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  AI: { run(model: string, input: unknown): Promise<unknown> }
}

type Facts = {
  facility: string
  county: string
  level: string
  commodity: string
  unit: string
  stockOnHand: number
  amc: number
  forecast: number[]
  monthsOfStock: number
  leadTimeMonths: number
  stockoutInDays: number | null
  risk: string
  trendPct: number
  anomaly?: { ratio: number; z: number } | null
  transfers: { from: string; quantity: number; fromMonthsAfter: number }[]
}

// Tried in order. Models get retired, so keep a fallback chain (checked Nov 2026).
const MODELS = ['@cf/meta/llama-3.1-8b-instruct-fast', '@cf/zai-org/glm-4.7-flash', '@cf/google/gemma-4-26b-a4b-it']

// Workers AI models return either { response } or an OpenAI-style { choices: [...] }
function textOf(out: unknown): string {
  const o = out as { response?: unknown; choices?: { message?: { content?: unknown } }[] }
  const raw = typeof o?.response === 'string' ? o.response : o?.choices?.[0]?.message?.content
  return typeof raw === 'string' ? raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : ''
}

const SYSTEM = `You support a Kenyan county health team.
In one or two plain sentences, explain why the situation described matters for patients at this kind of facility.
Rules: no numbers, no facility names, no quantities, no next steps, no headings. Under 45 words.
Do not mention outbreaks, reporting errors or diversion.`

// Used when the AI is unavailable or its note breaks the rules
const IMPACT: [string, string][] = [
  ['Artemether', 'Without first-line malaria treatment, patients, especially young children, may be turned away or referred, and untreated malaria can become severe within days.'],
  ['Amoxicillin', 'Children with pneumonia rely on this first-line antibiotic; a gap means delayed treatment or referral for an illness that can quickly become fatal.'],
  ['ORS', 'Oral rehydration with zinc is the first treatment for childhood diarrhoea; without it, dehydration can become dangerous quickly.'],
  ['Oxytocin', 'Oxytocin prevents and treats heavy bleeding after childbirth, a leading cause of maternal death, so every delivery needs it on hand.'],
  ['TLD', 'People living with HIV need uninterrupted treatment; missed refills risk treatment failure, drug resistance and onward transmission.'],
  ['DMPA', 'Clients who cannot get their contraceptive injection on time are at risk of unintended pregnancy and may not return.'],
]
const impactFor = (commodity: string) =>
  IMPACT.find(([k]) => commodity.startsWith(k))?.[1] ?? 'A gap in this essential medicine means patients may be turned away or referred.'

// Accept the AI note only if it follows the rules: short, no digits, no next steps
function cleanNote(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t || t.length > 320 || /\d/.test(t) || /\b(outbreak|diversion|transfer|order)\b/i.test(t)) return null
  return t
}

// Opening sentence, fixed per risk level
function situation(f: Facts): string {
  const head = `${f.facility} (${f.county}) holds ${f.stockOnHand} ${f.unit} of ${f.commodity}, about ${f.monthsOfStock} months of stock`
  const lead = `${f.leadTimeMonths} ${f.leadTimeMonths === 1 ? 'month' : 'months'}`
  const days = typeof f.stockoutInDays === 'number' ? `in about ${f.stockoutInDays} days` : 'within three months'
  switch (f.risk) {
    case 'critical': return `${head}. It will run out ${days}, before a normal resupply (${lead}) can arrive.`
    case 'high': return `${head}. That is only just more than the ${lead} a normal resupply takes, so there is little buffer.`
    case 'watch': return `${head}. That is below the 2.5-month comfort level, so the next order should be planned now.`
    case 'overstock': return `${head}. That is more than needed and some may expire before it is used.`
    default: return `${head}. Stock is adequate for now.`
  }
}

// Next steps with the exact figures
function requiredActions(f: Facts): string[] {
  const transfers = Array.isArray(f.transfers) ? f.transfers : []
  const actions = transfers.map(
    (t) => `Move ${t.quantity} ${f.unit} from ${t.from} (${t.from} keeps about ${t.fromMonthsAfter} months of stock).`,
  )
  if (f.anomaly) actions.unshift(`Before resupplying, check why last month's use was ${f.anomaly.ratio}× normal: an outbreak, a reporting error or diversion. Do not assume wrongdoing.`)
  if (!transfers.length && (f.risk === 'critical' || f.risk === 'high')) actions.push('No surplus in the county: raise an emergency order now.')
  if (f.risk === 'watch') actions.push(`Place the next routine order now so it arrives within the ${f.leadTimeMonths}-month lead time.`)
  if (f.risk === 'overstock') actions.push('Offer the surplus to nearby facilities that are short, and issue the oldest stock first to avoid expiry.')
  if (!actions.length) actions.push('No action needed; keep reviewing at the monthly report.')
  return actions
}

function compose(f: Facts, note: string): string {
  return [
    situation(f),
    note,
    requiredActions(f).map((x, i) => `${i + 1}. ${x}`).join('\n'),
    'Verify against the latest stock card before acting.',
  ].join('\n\n')
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

function valid(f: unknown): f is Facts {
  if (!f || typeof f !== 'object') return false
  const x = f as Record<string, unknown>
  return (
    typeof x.facility === 'string' && typeof x.county === 'string' && typeof x.commodity === 'string' &&
    typeof x.unit === 'string' && typeof x.risk === 'string' && typeof x.level === 'string' &&
    typeof x.stockOnHand === 'number' && typeof x.monthsOfStock === 'number' && typeof x.leadTimeMonths === 'number'
  )
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Open, read-only API so other systems (county dashboards, HMIS, i-LMIS) can pull Kinga's results
    if (url.pathname === '/api/assessments') {
      if (request.method !== 'GET') return json({ error: 'Use GET' }, 405)
      const county = url.searchParams.get('county')
      const risk = url.searchParams.get('risk')
      const all = assess(buildStock())
      const items = all
        .filter((a) => !county || a.county.toLowerCase() === county.toLowerCase())
        .filter((a) => !risk || a.risk === risk)
        .map(({ history: _h, ...rest }) => rest)
      return new Response(
        JSON.stringify({
          dataset: 'synthetic',
          generatedAt: new Date().toISOString(),
          count: items.length,
          items,
          transfers: suggestTransfers(all).filter((t) => !county || t.county.toLowerCase() === county.toLowerCase()),
        }),
        { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'max-age=300' } },
      )
    }

    if (url.pathname === '/api/explain') {
      if (request.method !== 'POST') return json({ error: 'Use POST' }, 405)
      const body = await request.text()
      if (body.length > 4000) return json({ error: 'Request too large' }, 413)

      let facts: unknown
      try {
        facts = JSON.parse(body)
      } catch {
        return json({ error: 'Invalid JSON' }, 400)
      }
      if (!valid(facts)) return json({ error: 'Missing fields' }, 400)

      const messages = [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Medicine: ${facts.commodity}. Facility level: ${facts.level}. Situation: ${situation(facts)}` },
      ]
      const errors: string[] = []
      for (const model of MODELS) {
        try {
          const note = cleanNote(textOf(await env.AI.run(model, { messages, max_tokens: 120, temperature: 0.2 })))
          if (note) return json({ text: compose(facts, note), model })
          errors.push(`${model}: note rejected`)
        } catch (e) {
          errors.push(`${model}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200))
        }
      }
      // Still a complete answer without the AI: the same text with a fixed patient-impact sentence
      return json({ text: compose(facts, impactFor(facts.commodity)), model: null, detail: errors })
    }

    return env.ASSETS.fetch(request)
  },
}

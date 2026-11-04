// Kinga Worker: serves the dashboard and one grounded AI endpoint.
// The model only explains numbers the engine already computed; it never invents data.
import { buildStock } from '../src/data'
import { assess, suggestTransfers } from '../src/engine'

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  AI: { run(model: string, input: unknown): Promise<{ response?: string }> }
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

const MODEL = '@cf/meta/llama-3.1-8b-instruct'

const SYSTEM = `You are a supply-chain assistant for a Kenyan county health team.
Explain a medicine stock-out risk to a county pharmacist in plain English.
Rules:
- Use ONLY the facts provided. Do not invent numbers, facilities or causes.
- If you suggest possible reasons (e.g. seasonal malaria), label them as possibilities to verify.
- If "anomaly" is present, say last month's use was unusually high and list the possibilities to check:
  an outbreak, a reporting error, or diversion. Do not accuse anyone.
- Give: (1) the situation in one sentence, (2) why it matters for patients, (3) up to three concrete next steps.
- Under 120 words. No headings. Plain sentences or a short numbered list.
- End with: "Verify against the latest stock card before acting."`

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

function valid(f: unknown): f is Facts {
  if (!f || typeof f !== 'object') return false
  const x = f as Record<string, unknown>
  return typeof x.facility === 'string' && typeof x.commodity === 'string' && typeof x.monthsOfStock === 'number'
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

      try {
        const out = await env.AI.run(MODEL, {
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: `Facts (JSON):\n${JSON.stringify(facts)}` },
          ],
          max_tokens: 300,
          temperature: 0.2,
        })
        return json({ text: out.response ?? '', model: MODEL })
      } catch {
        return json({ error: 'AI unavailable' }, 503)
      }
    }

    return env.ASSETS.fetch(request)
  },
}

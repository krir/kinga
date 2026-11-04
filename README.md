# Kinga — essential-medicine stock-out early warning

*Kinga* is Swahili for "protect". This prototype helps a county health team see which
facilities are about to run out of essential medicines, why, and what to do about it
before patients are turned away.

> **Prototype on synthetic data.** No real facility, stock or patient data is used.

## What it does

1. **Forecasts demand** for six tracer medicines (malaria, antibiotics, ORS/zinc,
   oxytocin, HIV treatment, family planning) across 10 facilities in 3 counties, from
   12 months of consumption history.
2. **Scores stock-out risk** against each facility's resupply lead time:
   - **Critical**: stock runs out before a normal order can arrive
   - **High**: less than half a month of buffer beyond lead time
   - **Watch**: under 2.5 months of stock
   - **Overstock**: over 6 months, a sign of expiry and wastage risk
3. **Flags unusual spikes**: a month far above normal use (seasonally adjusted) is marked
   for investigation, as it can signal a disease outbreak, a reporting error or diversion.
4. **Suggests redistribution**: moves surplus from nearby facilities in the same county,
   never leaving a donor below three months of stock, and skips transfers too small to
   justify a trip.
5. **Explains each warning in plain language** for a county pharmacist: the figures and
   steps come from the rules, with a patient-impact note from an LLM on Cloudflare Workers AI
   (Llama 3.1 8B fast, with GLM-4.7 Flash and Gemma 4 as fallbacks).

## Open API

Other systems can pull Kinga's results as JSON, read-only:

```
GET /api/assessments                 all items and suggested transfers
GET /api/assessments?county=Kericho  one county
GET /api/assessments?risk=critical   one risk level
```

## Where Kinga fits in Kenya's digital health system

Kinga is designed as a **decision layer on top of national systems, not a replacement**:

| System | Role | How Kinga would use it |
|---|---|---|
| **Taifa Care HMIS** (SHA) | Facility system for visits, claims and dispensing at public Level 2–5 facilities | Dispensing and visit data as the demand signal |
| **KEMSA i-LMIS** | National ordering, delivery and stock visibility | Lead times, deliveries and stock on hand |
| **KHIS (DHIS2)** | Aggregate monthly reporting | Historical consumption by facility |
| **Health Information Exchange** (Digital Health Act 2023) | National data sharing using **FHIR** | Standard way to read the data above |

What Kinga adds is county-level: redistribution between nearby facilities, spike alerts,
and plain-language explanations for the people who act on them.

## Method

| Step | Approach |
|---|---|
| Demand forecast | Holt linear exponential smoothing (α 0.5, β 0.3), 3-month horizon |
| Seasonality | Malaria medicines are de-seasonalised with a long-rains index, forecast, then re-seasonalised |
| Trend | Quarter-on-quarter change on seasonally adjusted demand |
| Months of stock | Stock on hand ÷ mean forecast demand |
| Stock-out date | Month-by-month walk-forward of stock against forecast |

The rules are deliberately simple and auditable. A pharmacist can check every number by hand.

## Responsible AI

- **Numbers never come from the model:** every figure, date and next step in an
  explanation is written by Kinga's rules. The AI writes only a short note on why the
  situation matters for patients.
- **Checked output:** the AI note is rejected if it contains any number, a next step or
  an accusation, and a standard note is used instead.
- **Human in the loop:** the AI explains, it does not decide. Every output ends with an
  instruction to verify against the stock card, and the label says which part is AI.
- **Graceful fallback:** if the AI service is unavailable, the same answer is shown with a
  standard patient note, clearly labelled.
- **Privacy:** no personal data is involved; facility-level aggregates only.
- **Input limits:** the API accepts small validated JSON only (4 KB cap).

## Limitations and next steps

- Synthetic data. Next: read real data through the Health Information Exchange using
  FHIR (dispensing events, deliveries, stock reports) from Taifa Care HMIS, KEMSA i-LMIS
  and KHIS.
- **Link stock to patients:** expected ANC deliveries to forecast oxytocin; HIV clients
  due for refills to forecast TLD, and flag missed refills.
- **Built for remote facilities:** offline-first mobile view, alerts by SMS or WhatsApp,
  and the assistant in Swahili.
- **Guideline assistant:** answers from Kenya's treatment guidelines and essential
  medicines list, with citations.
- Lead times are fixed per facility level. Next: learn them from actual delivery records.
- Transfers ignore distance and road access within a county. Next: add travel time.
- Validate forecast accuracy (MAPE) against held-out months on real data.
- Co-design thresholds and wording with county pharmacists before any use.

## Stack

React + TypeScript (Vite) dashboard, a Cloudflare Worker for the `/api/explain`
endpoint, and Workers AI for the LLM. Deployed on Cloudflare.

```
src/data.ts      synthetic facilities, medicines and consumption
src/engine.ts    forecast, risk, transfers, rule-based summary
src/App.tsx      dashboard
worker/index.ts  API route + grounded prompt
```

## Run and deploy

```powershell
npm install
npm run dev        # dashboard at localhost:5173 (assistant shows the rule-based summary)
npx wrangler login
npm run deploy     # dashboard + AI at kinga.kennedykorir.com
```

© 2026 Kennedy Korir. All rights reserved. See [LICENSE](LICENSE).

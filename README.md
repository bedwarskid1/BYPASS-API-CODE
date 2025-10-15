# Solver API (hybrid)

POST /bypass { "url":"https://..." } -> JSON { bypassed, method, raw, error }
GET /health -> { status: "ok" }

To run locally:
1. npm install
2. npx playwright install chromium
3. npm start

Set env ENABLE_EXTERNAL_APIS=true to enable calling abysm/trw.

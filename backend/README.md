# A2A Orchestrator Backend

JSON-RPC orchestrator that stores agents, versions, runs, and events in MongoDB Atlas and can spawn agents that spawn more agents.

## Setup

- Requirements: Node 18+, MongoDB Atlas URI
- Env vars:
  - `MONGODB_URI` (required)
  - `MONGODB_DB` (default: `a2a`)
  - `MODEL_NAME` (optional; default: `gpt-4o`)
  - `OPENAI_API_KEY` (optional; if absent uses mock model)
  - `FIREWORKS_API_KEY` (optional; if set, uses Fireworks instead of OpenAI)
  - `FIREWORKS_MODEL` (optional; default `accounts/fireworks/models/deepseek-v3p2`)
  - `PORT` (default: `4000`)
  - `A2A_MAX_DEPTH` (optional; default: `2`)
  - `A2A_MAX_CHILDREN` (optional; default: `3`)
  - `A2A_ROUTER_INDEX_LIMIT` (optional; default: `50`)
  - `A2A_SPECIALIST_INDEX_LIMIT` (optional; default: `50`)
  - `MAIN_ROUTER_SLUG` (optional; default: `company_router`)
  - `MAIN_ROUTER_NAME` (optional; default: `Company Router`)

## Commands

```bash
cd backend
npm install
npm run dev      # ts-node-dev
npm run build    # emit dist
npm run start    # run compiled
npm run seed     # seed demo agent + bootstrap
npm run test     # run unit tests
```

## JSON-RPC Endpoint

`POST /rpc` with `{"jsonrpc":"2.0","id":"1","method":"...","params":{...}}`

Example cURL (assuming `PORT=4000`):

```bash
curl -s -X POST http://localhost:4000/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"session.create","params":{"title":"demo"}}'
```

Start a run with bootstrap:

```bash
curl -s -X POST http://localhost:4000/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"run.start","params":{"sessionId":"<SESSION>","agentSlug":"bootstrap","userMessage":"plan a demo"}}'
```

Fetch events:

```bash
curl -s -X POST http://localhost:4000/rpc \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"run.events\",\"params\":{\"runId\":\"<RUN>\"}}"
```

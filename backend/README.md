# A2A Orchestrator Backend

JSON-RPC orchestrator that stores agents, versions, runs, and events in MongoDB Atlas and can spawn agents that spawn more agents.

## Setup

- Requirements: Node 18+, MongoDB Atlas URI
- Env vars:
  - `MONGODB_URI` (required)
  - `MONGODB_DB` (default: `a2a`)
  - `OPENAI_API_KEY` (optional; if absent uses mock model)
  - `PORT` (default: `4000`)

## Commands

```bash
cd backend
npm install
npm run dev      # ts-node-dev
npm run build    # emit dist
npm run start    # run compiled
npm run seed     # seed demo agent + bootstrap
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

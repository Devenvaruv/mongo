# A2A Frontend (Vite + React)

Static UI for the JSON-RPC orchestrator. Works on Vercel (static export).

## Setup

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

Create `.env` (or `.env.local`) with:

```
VITE_BACKEND_URL=http://localhost:4000
```

## Pages
- Playground: create session, pick agent (includes bootstrap), run prompt, watch events and final JSON.
- Run Inspector: enter sessionId, browse run tree, view events + output.
- Agent Manager: list agents, view versions, edit system prompt (creates new version).

Build for deploy:

```bash
npm run build
```

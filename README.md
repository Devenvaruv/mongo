# A2A Agents that Create Agents (MVP)

Monorepo with `backend` (JSON-RPC orchestrator, Node/TS/Express) and `frontend` (React/Vite) for managing/running agents stored in MongoDB Atlas.

## UI Overview

- Home: create a session, describe the agents you want, and run the orchestrator to create them.
- Playground: chat with created agents and stream run events/output.
- Run Inspector: browse past runs by session and inspect details/events.
- Agent Manager: view agent cards, select versions, and set the default version.

## Quickstart

1) Backend
```bash
cd backend
npm install
# create .env with MONGODB_URI, MONGODB_DB, OPENAI_API_KEY(optional), PORT
npm run dev            # or npm run start after build
npm run seed           # optional demo agent + bootstrap
```

2) Frontend
```bash
cd frontend
npm install
echo \"VITE_BACKEND_URL=http://localhost:4000\" > .env.local
npm run dev
```

Deploy frontend as static build (`npm run build`) to Vercel; backend runs anywhere Node can reach MongoDB Atlas.

## Agent Cards

Each agent can expose a well-known card endpoint:
```
http://localhost:4000/.well-known/agent-card.json?slug=<agent-slug>
```

## Notes

- MongoDB Atlas must allow your current IP, or the backend will fail to connect.

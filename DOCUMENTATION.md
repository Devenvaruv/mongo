# A2A Agents That Create Agents — Project Overview

This repo is a monorepo with a backend JSON-RPC orchestrator and a frontend UI. Agents, versions, runs, and events live in MongoDB Atlas. The system can spawn new agents on the fly, execute them as child runs, and provides full observability (runs, events, versions, cards).

## Backend (Node.js + TypeScript)
Key files/modules:
- `src/index.ts`: Express bootstrap. Wires JSON-RPC POST `/rpc`, well-known agent card GET `/.well-known/agent-card.json?slug=<slug>`, ensures indexes/bootstrap agent on startup.
- `src/db.ts`: Mongo connection helper, collection handles, and index creation.
- `src/models.ts`: Shared TypeScript types for agents, versions, sessions, runs, events, model requests/responses.
- `src/bootstrap.ts`: Defines the hardcoded bootstrap/orchestrator agent prompt and ensures it exists. Exposes `ensureBootstrapAgent`.
- `src/mockModel.ts`: Model abstraction. Uses Fireworks if `FIREWORKS_API_KEY`, else OpenAI if `OPENAI_API_KEY`, else mock responses. Default model is `MODEL_NAME` (env, default `gpt-4o`).
- `src/runEngine.ts`: Core run executor. Loads runs/agents/versions, emits events, calls the model, parses JSON, handles plan/final branching, spawns agents (with dedupe), creates child runs, enforces spawn cap, merges outputs.
- `src/rpc.ts`: JSON-RPC method handlers (session, agent, run). Dispatches to run engine for `run.start`.
- `src/seed.ts`: Optional seed for demo agent + bootstrap.

Data collections (MongoDB):
- `agents`: stable identity; points to `activeVersionId`; stores metadata + card.
- `agent_versions`: append-only versions with systemPrompt, resources, ioSchema, routingHints.
- `sessions`: conversational/session grouping.
- `runs`: each execution; pins `agentVersionId`; tracks status, input/output, parent/root run IDs.
- `events`: append-only stream per run with seq and typed payloads.

Important behaviors:
- Version pinning: each run captures `agentVersionId` at start.
- Events: RUN_STARTED, PROMPT_LOADED, MODEL_REQUEST/RESPONSE, SPAWN_AGENT_*, CHILD_RUN_*, RUN_FINISHED, ERROR.
- Plans: agent responses may be `{"type":"plan", agentsToCreate, runsToExecute, mergeStrategy}`. The engine validates, enforces spawn cap, upserts agents/versions, and executes child runs sequentially.
- Agent cards: when spawning agents, a card in A2A-like format is stored under `agent.metadata.card`. Exposed via well-known endpoint.
- Model selection: `MODEL_NAME` (default `gpt-4o`) for all calls; Fireworks/OpenAI/mock chosen by available API keys.

JSON-RPC API (POST /rpc):
- `session.create`: {title?} -> {sessionId}
- `session.list`: {limit?} -> {sessions}
- `agent.list`: {} -> {agents}
- `agent.get`: {agentId?, slug?} -> {agent, activeVersion, versions}
- `agent.version.get`: {versionId, agentId?} -> {version}
- `agent.updatePrompt`: {agentId, newSystemPrompt, editor} -> {agentVersionId, version}
- `agent.setActiveVersion`: {agentId, versionId} -> {activeVersionId}
- `run.start`: {sessionId, agentSlug?, agentId?, userMessage, parentRunId?} -> {runId}
- `run.get`: {runId} -> {run}
- `run.events`: {runId, sinceSeq?} -> {events, nextSeq}
- `run.tree`: {sessionId} -> {runs} (includes agentSlug/agentName)

Well-known card:
- `GET /.well-known/agent-card.json?slug=<slug>` -> returns `metadata.card` for the agent or 404.

Run execution flow (`runEngine.executeRun`):
1) Load run; emit RUN_STARTED.
2) Load agent + pinned version; emit PROMPT_LOADED.
3) Build system prompt (agent system prompt + A2A instruction). Build user content with Context: availableAgents + directoryAgent helper.
4) Emit MODEL_REQUEST; call model; parse JSON strictly.
5) Emit MODEL_RESPONSE.
6) If `type: "final"`: store output, mark succeeded, emit RUN_FINISHED.
7) If `type: "plan"`:
   - Normalize legacy keys (agents/runs).
   - Enforce spawn cap (limit 10).
   - Emit SPAWN_AGENT_REQUEST.
   - `spawnAgentsFromPlan`: dedupe by slug/name/tags; reuse identical prompt; otherwise new version or new agent; emit SPAWN_AGENT_CREATED.
   - For each run in `runsToExecute`: create child run (with context, availableAgents info), emit CHILD_RUN_STARTED, execute child, emit CHILD_RUN_FINISHED.
   - Merge outputs: `childResultsBySlug`, `planSummary`.
   - Store output, mark succeeded, emit RUN_FINISHED.
8) On error: store error, emit ERROR + RUN_FINISHED.

Files and how they connect:
- `rpc.ts` -> calls `executeRun` in `runEngine.ts`; both use models/types from `models.ts` and DB handles from `db.ts`.
- `runEngine.ts` -> uses `callModel` (mockModel), `ensureBootstrapAgent` (bootstrap), and collections from `db.ts`.
- `mockModel.ts` -> chooses Fireworks/OpenAI/mock; no dependency on run engine.
- `bootstrap.ts` -> ensures bootstrap agent/version exists; used at server start and as fallback in `runEngine`.
- `index.ts` -> initializes DB (ensureIndexes), bootstrap agent, binds routes and RPC handler.

Frontend (React + Vite)
Key screens (`src/App.tsx`):
- Home: create session and trigger bootstrap to spawn agents.
- Playground: pick agent, send prompt, stream events, view final JSON.
- Run Inspector: load session runs (tree), click run to view events/output.
- Agent Manager: list agents, view versions, set active version, create new versions (update prompt).
API client (`src/api.ts`): wrappers around JSON-RPC methods.

Typical workflows
- Agent creation (bootstrap): Home -> describe agents -> `run.start` with bootstrap -> bootstrap returns plan -> engine spawns agents/versions -> child runs executed -> final merged output.
- Run existing agent: create session -> select agent -> `run.start` -> poll `run.events` -> inspect output.
- Inspect history: Run Inspector -> `run.tree` -> drill into runs/events/output.
- Manage versions: Agent Manager -> `agent.get` + versions -> `agent.updatePrompt` -> optional `agent.setActiveVersion`.
- Fetch agent card: `/.well-known/agent-card.json?slug=<slug>`.

Environment
- `MONGODB_URI`, `MONGODB_DB`
- `MODEL_NAME` (default `gpt-4o`)
- `OPENAI_API_KEY` (optional)
- `FIREWORKS_API_KEY` / `FIREWORKS_MODEL` (optional)
- `PORT`

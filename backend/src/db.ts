import { Collection, Db, MongoClient, ObjectId } from "mongodb";
import {
  AgentDoc,
  AgentVersionDoc,
  EventDoc,
  RunDoc,
  SessionDoc,
} from "./models";

export interface DbCollections {
  db: Db;
  client: MongoClient;
  agents: Collection<AgentDoc>;
  agentVersions: Collection<AgentVersionDoc>;
  sessions: Collection<SessionDoc>;
  runs: Collection<RunDoc>;
  events: Collection<EventDoc>;
}

let cachedClient: MongoClient | null = null;

export async function getCollections(): Promise<DbCollections> {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required");
  }
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || "a2a";

  if (!cachedClient) {
    cachedClient = new MongoClient(uri);
    await cachedClient.connect();
  }

  const db = cachedClient.db(dbName);

  return {
    db,
    client: cachedClient,
    agents: db.collection<AgentDoc>("agents"),
    agentVersions: db.collection<AgentVersionDoc>("agent_versions"),
    sessions: db.collection<SessionDoc>("sessions"),
    runs: db.collection<RunDoc>("runs"),
    events: db.collection<EventDoc>("events"),
  };
}

export async function ensureIndexes(collections: DbCollections) {
  await collections.agents.createIndex({ slug: 1 }, { unique: true });
  await collections.agentVersions.createIndex({ agentId: 1, version: -1 });
  await collections.agentVersions.createIndex({ agentId: 1 });
  await collections.sessions.createIndex({ createdAt: -1 });
  await collections.runs.createIndex({ sessionId: 1, startedAt: -1 });
  await collections.runs.createIndex({ parentRunId: 1 });
  await collections.runs.createIndex({ agentId: 1, startedAt: -1 });
  await collections.events.createIndex({ runId: 1, seq: 1 }, { unique: true });
  await collections.events.createIndex({ runId: 1, ts: 1 });
}

export function toObjectId(id: string | ObjectId | null | undefined): ObjectId {
  if (!id) {
    return new ObjectId();
  }
  return typeof id === "string" ? new ObjectId(id) : id;
}

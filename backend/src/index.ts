import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ensureIndexes, getCollections } from "./db";
import { rpcHandler } from "./rpc";
import { ensureBootstrapAgent } from "./bootstrap";

dotenv.config();

async function start() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.post("/rpc", rpcHandler);

  const port = process.env.PORT || 4000;

  try {
    const collections = await getCollections();
    await ensureIndexes(collections);
    await ensureBootstrapAgent(collections);
    app.listen(port, () => {
      console.log(`JSON-RPC server listening on http://localhost:${port}`);
    });
  } catch (err) {
    console.error("Failed to start server", err);
    process.exit(1);
  }
}

start();

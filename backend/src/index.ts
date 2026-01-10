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

   // Well-known agent card: /.well-known/agent-card.json?slug=<agent-slug>
  app.get("/.well-known/agent-card.json", async (req, res) => {
    try {
      const slug = (req.query.slug as string) || "";
      if (!slug) {
        return res.status(400).json({ error: "slug query param is required" });
      }
      const collections = await getCollections();
      const agent = await collections.agents.findOne({ slug });
      if (!agent) {
        return res.status(404).json({ error: "agent not found" });
      }
      const card = (agent as any).metadata?.card;
      if (!card) {
        return res.status(404).json({ error: "agent card not found" });
      }
      return res.json(card);
    } catch (err: any) {
      console.error("well-known agent card error", err);
      return res.status(500).json({ error: "internal error" });
    }
  });

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

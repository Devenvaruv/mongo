import dotenv from "dotenv";
import { ObjectId } from "mongodb";
import { ensureBootstrapAgent } from "./bootstrap";
import { ensureIndexes, getCollections } from "./db";

dotenv.config();

async function seed() {
  const collections = await getCollections();
  await ensureIndexes(collections);
  await ensureBootstrapAgent(collections);

  const slug = "demo-echo";
  const existing = await collections.agents.findOne({ slug });
  if (existing) {
    console.log(`Agent ${slug} already exists, skipping.`);
    return;
  }
  const now = new Date();
  const agentId = new ObjectId();
  const versionId = new ObjectId();
  await collections.agents.insertOne({
    _id: agentId,
    slug,
    name: "Demo Echo",
    description: "Echoes userMessage into a JSON final result.",
    activeVersionId: versionId,
    createdAt: now,
    updatedAt: now,
    createdBy: { type: "system" },
  });
  await collections.agentVersions.insertOne({
    _id: versionId,
    agentId,
    version: 1,
    systemPrompt:
      'You are Demo Echo. Output JSON only: {"type":"final","result":{"echo":<string>,"upper":<string>}}. Echo userMessage, and also provide upper-case version.',
    resources: [],
    ioSchema: { output: {} },
    routingHints: { tags: ["demo"] },
    createdAt: now,
    createdBy: { type: "system" },
  });
  console.log("Seeded demo agent");
}

seed()
  .then(() => {
    console.log("Seed complete");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Seed failed", err);
    process.exit(1);
  });

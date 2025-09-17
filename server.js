// server.js
const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
dotenv.config();

const { createSession, getSession, appendToSession, clearSession ,getAllKeys } = require("./sessionManager");
const { fetchArticles, initCollection, ingestToQdrant, retrieveTopK, buildPromptWithHistory, askModel } = require("./reg");

const app = express();
app.use(bodyParser.json());

// Health
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Create new session
app.post("/sessions", async (req, res) => {
  try {
    const sessionId = await createSession();
    res.status(201).json({ sessionId });
  } catch (err) {
    console.error("create session err:", err);
    res.status(500).json({ error: "failed to create session" });
  }
});

// Get session history
app.get("/sessions/:id/history", async (req, res) => {
  const id = req.params.id;
  try {
    const history = await getSession(id);
    if (history === null) return res.status(404).json({ error: "session not found" });
    res.json({ sessionId: id, history });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load session" });
  }
});

// Clear session
app.delete("/sessions/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const cleared = await clearSession(id);
    res.json({ sessionId: id, history: cleared });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to clear session" });
  }
});

// Ingest endpoint (run RSS ingest -> embeddings -> Qdrant). Call manually or from cron.
app.post("/ingest", async (req, res) => {
  try {
    const articles = await fetchArticles();
    await initCollection();
    await ingestToQdrant(articles);
    res.json({ status: "ok", ingested: articles.length });
  } catch (err) {
    console.error("ingest err:", err);
    res.status(500).json({ error: "failed to ingest" });
  }
});

// Chat endpoint: provide sessionId and query -> returns answer and appends to session
app.post("/sessions/:id/chat", async (req, res) => {
  const sessionId = req.params.id;
  const { query, topK } = req.body || {};
  if (!query || typeof query !== "string") return res.status(400).json({ error: "query missing" });

  try {
    const history = (await getSession(sessionId)) || [];
    // Retrieve relevant passages
    const k = parseInt(topK || "5", 10);
    const passages = await retrieveTopK(query, k);

    // Build prompt from history + passages
    const prompt = buildPromptWithHistory(history, query, passages);
    console.log("Prompt:", prompt);
    // Ask model
    const answer = await askModel(prompt);

    // Save to session
    const newHistory = await appendToSession(sessionId, { query, answer });

    res.json({ sessionId, query, answer, history: newHistory });
  } catch (err) {
    console.error("chat err:", err);
    res.status(500).json({ error: "chat failed", detail: err.response?.data || err.message });
  }
});
app.get("/getAll", async (req, res) => {
  const allKeys = await getAllKeys();
  res.json({ Keys: allKeys });
})

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RAG server running on http://localhost:${PORT}`);
});

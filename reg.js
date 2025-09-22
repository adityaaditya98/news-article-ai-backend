// rag.js
const Parser = require("rss-parser");
const axios = require("axios");
const { QdrantClient } = require("@qdrant/js-client-rest");
const { v4: uuidv4 } = require("uuid");
const dotenv = require("dotenv");
const { cacheGet, cacheSet } = require("./sessionManager");
dotenv.config();

const RSS_FEEDS = [
  "https://feeds.bbci.co.uk/news/world/rss.xml",
  "https://www.theguardian.com/world/rss",
  "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
  "https://www.indiatoday.in/rss/1206577.xml",
  "https://www.aljazeera.com/xml/rss/all.xml"
];

const JINA_EMBED_URL = "https://api.jina.ai/v1/embeddings";
const EMBED_MODEL = process.env.EMBEDDING_MODEL || "jina-embeddings-v2-base-en";
const EMBED_SIZE = parseInt(process.env.EMBEDDING_SIZE || "768", 10);

const GEMINI_API_URL = process.env.GEMINI_API_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL,
  apiKey: process.env.QDRANT_API_KEY
});

const COLLECTION = process.env.COLLECTION_NAME || "news_articles";

// --- Utility: simple hash for caching keys ---
function simpleHash(s) {
  // quick non-crypto hash
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

// --- Ingest articles (fetch RSS pages, embed, push to Qdrant) ---
async function fetchArticles(limit = 100) {
  const parser = new Parser();
  let articles = [];
  for (const url of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      if (feed.items && feed.items.length) {
        const mapped = feed.items.map((it) => ({
          id: uuidv4(),
          title: it.title || "untitled",
          content: it.contentSnippet || it.content || it.title || "",
          link: it.link || null
        }));
        articles = articles.concat(mapped);
        if (articles.length >= limit) break;
      }
    } catch (err) {
      console.warn("RSS fetch failed:", url, err.message);
    }
  }
  return articles.slice(0, limit);
}

async function getEmbedding(text) {
  if (!text || !text.trim()) return null;
  const key = `embed:${simpleHash(text)}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  const res = await axios.post(
    JINA_EMBED_URL,
    { model: EMBED_MODEL, input: text },
    { headers: { Authorization: `Bearer ${process.env.JINA_API_KEY}`, "Content-Type": "application/json" } }
  );
  const embedding = res.data?.data?.[0]?.embedding;
  if (!embedding) throw new Error("No embedding returned");
  await cacheSet(key, embedding, 60 * 60 * 24); // cache 24h
  return embedding;
}

async function initCollection() {
  try {
    await qdrant.recreateCollection(COLLECTION, { vectors: { size: EMBED_SIZE, distance: "Cosine" } });
  } catch (err) {
    // if recreation fails, try to check existence or ignore
    console.warn("initCollection warning:", err.message);
  }
}

async function ingestToQdrant(articles) {
  const points = [];
  for (const a of articles) {
    const emb = await getEmbedding(a.content);
    points.push({ id: a.id, vector: emb, payload: { title: a.title, content: a.content, link: a.link } });
  }
  // Qdrant upsert
  await qdrant.upsert(COLLECTION, { points });
}

// Retrieve: embed query, search Qdrant, return payloads
async function retrieveTopK(query, k = 5) {
  const cacheKey = `retrieve:${simpleHash(query)}:k${k}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const emb = await getEmbedding(query);
  const results = await qdrant.search(COLLECTION, { vector: emb, limit: k });
  const payloads = results.map((r) => r.payload);
  await cacheSet(cacheKey, payloads, 60 * 5); // cache 5 minutes
  return payloads;
}

// Build a safe prompt using retrieved passages + history
function buildPromptWithHistory(history, query, passages) {
  const histText = (history || []).map((h, i) => `Q${i + 1}: ${h.query}\nA${i + 1}: ${h.answer}`).join("\n");
  const context = passages.map((p, i) => `[Passage ${i + 1}]\nTitle: ${p.title}\nContent: ${p.content}`).join("\n\n");
  return `${histText ? "Conversation so far:\n" + histText + "\n\n" : ""}Context:\n${context}\n\nUser: ${query}\n\nInstructions:\n1) Use only the passages above and conversation history.\n2) Be concise and don't invent facts.\n3) If answer is not in context, reply: "Information not available in the retrieved passages."\n4) If user query is a general/basic message (e.g., greetings, small talk like 'how are you'), reply politely in a conversational way.\n\nAnswer:`;

}

// Ask Gemini (or text-bison fallback) with prompt
async function askModel(prompt) {
  try {
    const response = await axios.post(
      `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
      { contents: [{ role: "user", parts: [{ text: prompt }] }] },
      { headers: { "Content-Type": "application/json" } }
    );
    return response.data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (err) {
    console.error("askModel error:", err.response?.data || err.message);
    throw err;
  }
}

module.exports = {
  fetchArticles,
  initCollection,
  ingestToQdrant,
  retrieveTopK,
  buildPromptWithHistory,
  askModel
};

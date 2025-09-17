// sessionManager.js
const redis = require("redis");
const dotenv = require("dotenv");
dotenv.config();
const { createClient } = redis;

const client = createClient({
    username: 'default',
    password: process.env.Password_redis,
    socket: {
        host: process.env.Host_redis,
        port: process.env.Port_redis
    }
});
(async () => {
    client.on('error', err => console.log('Redis Client Error', err));

await client.connect();

await client.set('foo', 'bar');
const result = await client.get('foo');
console.log(result) 
})();


const SESSION_TTL = parseInt(process.env.SESSION_TTL_SECONDS || "1800", 10);

// Create a new session with empty history
async function createSession(sessionId, ttl = SESSION_TTL) {
  const id = sessionId || require("uuid").v4();
  await client.set(id, JSON.stringify([]), { EX: ttl });
  return id;
}

// Load session history array
async function getSession(sessionId) {
  const data = await client.get(sessionId);
  return data ? JSON.parse(data) : null;
}

// Append event to session history
async function appendToSession(sessionId, entry, ttl = SESSION_TTL) {
  const history = (await getSession(sessionId)) || [];
  history.push(entry);
  await client.set(sessionId, JSON.stringify(history), { EX: ttl });
  return history;
}

// Overwrite session history
async function saveSession(sessionId, history, ttl = SESSION_TTL) {
  await client.set(sessionId, JSON.stringify(history), { EX: ttl });
  return history;
}

// Clear session (reset to empty array)
async function clearSession(sessionId, ttl = SESSION_TTL) {
  await client.set(sessionId, JSON.stringify([]), { EX: ttl });
  return [];
}

// Caching helpers for embeddings and retrieval results
async function cacheSet(key, value, ttl = 3600) {
  await client.set(key, typeof value === "string" ? value : JSON.stringify(value), { EX: ttl });
}
async function cacheGet(key) {
  const v = await client.get(key);
  return v ? JSON.parse(v) : null;
}

async function getAllKeys() {
  const keys = (await client.keys('*')).filter(key => (!(key.includes("embed:") || key.includes("retrieve:"))&& key.length>=5));
  return keys;
}

module.exports = {
  createSession,
  getSession,
  appendToSession,
  saveSession,
  clearSession,
  cacheSet,
  cacheGet,
  getAllKeys,
  redisClient: client
};

// ── Accounts database ────────────────────────────────────────────
// A small, self-contained Postgres layer for real (cross-device) player
// accounts. Everything else in this project (rooms, games, AI) stays
// exactly as it was — this module is only ever consulted for signup,
// login, session resume, and profile updates.
//
// Requires a DATABASE_URL environment variable (Railway's Postgres plugin
// provides this automatically once connected to the app service). If
// it's not set, server.js simply disables the account system and the
// game keeps working as guest-only, per its existing behavior.

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's private network connection (the normal case, when the
  // Postgres plugin and this app share a project) doesn't need SSL.
  // If you're connecting to a Postgres instance that requires it (e.g.
  // an external/public connection string), set PGSSL=true.
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', err => {
  // A dropped idle connection shouldn't take the whole process down.
  console.error('Unexpected Postgres pool error:', err.message);
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL,
      username_lower TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      nickname TEXT NOT NULL,
      avatar TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS sessions_account_id_idx ON sessions(account_id);`);
}

function toPublic(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, nickname: row.nickname, avatar: row.avatar };
}

async function createAccount({ username, passwordHash, nickname, avatar }) {
  const { rows } = await pool.query(
    `INSERT INTO accounts (username, username_lower, password_hash, nickname, avatar)
     VALUES ($1, lower($1), $2, $3, $4) RETURNING *`,
    [username, passwordHash, nickname, avatar]
  );
  return rows[0];
}

async function findAccountByUsername(username) {
  const { rows } = await pool.query(`SELECT * FROM accounts WHERE username_lower = lower($1)`, [username]);
  return rows[0] || null;
}

async function findAccountById(id) {
  const { rows } = await pool.query(`SELECT * FROM accounts WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function createSession(accountId, token) {
  await pool.query(`INSERT INTO sessions (token, account_id) VALUES ($1, $2)`, [token, accountId]);
}

async function findAccountByToken(token) {
  const { rows } = await pool.query(
    `SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token = $1`,
    [token]
  );
  if (rows[0]) {
    // Best-effort — a failed "touch" shouldn't block the actual request.
    pool.query(`UPDATE sessions SET last_seen = now() WHERE token = $1`, [token]).catch(() => {});
  }
  return rows[0] || null;
}

async function deleteSession(token) {
  await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
}

async function updateProfile(accountId, { nickname, avatar }) {
  const { rows } = await pool.query(
    `UPDATE accounts SET nickname = $2, avatar = $3 WHERE id = $1 RETURNING *`,
    [accountId, nickname, avatar]
  );
  return rows[0];
}

module.exports = {
  pool, ensureSchema, toPublic,
  createAccount, findAccountByUsername, findAccountById,
  createSession, findAccountByToken, deleteSession, updateProfile,
};

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
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stats (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      games_played INTEGER NOT NULL DEFAULT 0,
      games_finished INTEGER NOT NULL DEFAULT 0,
      best_trick INTEGER,
      worst_trick INTEGER,
      best_round INTEGER,
      worst_round INTEGER,
      best_game INTEGER,
      worst_game INTEGER,
      moons_total INTEGER NOT NULL DEFAULT 0,
      moons_best_game INTEGER NOT NULL DEFAULT 0,
      queen_spades_taken INTEGER NOT NULL DEFAULT 0,
      points_total INTEGER NOT NULL DEFAULT 0,
      ended_positive INTEGER NOT NULL DEFAULT 0,
      ended_negative INTEGER NOT NULL DEFAULT 0,
      win_streak_current INTEGER NOT NULL DEFAULT 0,
      win_streak_best INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Older deployments may already have a stats table from before these
  // columns existed — add them if missing so upgrading doesn't require
  // a manual migration.
  await pool.query(`ALTER TABLE stats ADD COLUMN IF NOT EXISTS best_round INTEGER;`);
  await pool.query(`ALTER TABLE stats ADD COLUMN IF NOT EXISTS worst_round INTEGER;`);
  await pool.query(`ALTER TABLE stats ADD COLUMN IF NOT EXISTS queen_spades_taken INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE stats ADD COLUMN IF NOT EXISTS points_total INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE stats ADD COLUMN IF NOT EXISTS ended_positive INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE stats ADD COLUMN IF NOT EXISTS ended_negative INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE stats ADD COLUMN IF NOT EXISTS win_streak_current INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE stats ADD COLUMN IF NOT EXISTS win_streak_best INTEGER NOT NULL DEFAULT 0;`);
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

// ── Stats ──────────────────────────────────────────────────────
// Each of these is a single atomic upsert (INSERT ... ON CONFLICT), so
// concurrent games finishing at the same moment for the same account
// can never race each other or lose an update. GREATEST/LEAST ignore
// NULLs in Postgres, so a brand-new row (no trick/game recorded yet)
// is handled correctly the first time either lands, regardless of order.

async function recordGameStarted(accountId) {
  await pool.query(
    `INSERT INTO stats (account_id, games_played) VALUES ($1, 1)
     ON CONFLICT (account_id) DO UPDATE SET games_played = stats.games_played + 1, updated_at = now()`,
    [accountId]
  );
}

async function recordTrick(accountId, trickScore) {
  await pool.query(
    `INSERT INTO stats (account_id, best_trick, worst_trick) VALUES ($1, $2, $2)
     ON CONFLICT (account_id) DO UPDATE SET
       best_trick = GREATEST(stats.best_trick, $2),
       worst_trick = LEAST(stats.worst_trick, $2),
       updated_at = now()`,
    [accountId, trickScore]
  );
}

async function recordRound(accountId, roundDelta) {
  await pool.query(
    `INSERT INTO stats (account_id, best_round, worst_round) VALUES ($1, $2, $2)
     ON CONFLICT (account_id) DO UPDATE SET
       best_round = GREATEST(stats.best_round, $2),
       worst_round = LEAST(stats.worst_round, $2),
       updated_at = now()`,
    [accountId, roundDelta]
  );
}

async function recordQueenTaken(accountId) {
  await pool.query(
    `INSERT INTO stats (account_id, queen_spades_taken) VALUES ($1, 1)
     ON CONFLICT (account_id) DO UPDATE SET
       queen_spades_taken = stats.queen_spades_taken + 1,
       updated_at = now()`,
    [accountId]
  );
}

async function recordGameFinished(accountId, finalScore, moonsThisGame) {
  const endedPositive = finalScore > 0 ? 1 : 0;
  const endedNegative = finalScore < 0 ? 1 : 0;
  await pool.query(
    `INSERT INTO stats (
       account_id, games_finished, best_game, worst_game, moons_total, moons_best_game,
       points_total, ended_positive, ended_negative, win_streak_current, win_streak_best
     )
     VALUES ($1, 1, $2, $2, $3, $3, $2, $4, $5, $4, $4)
     ON CONFLICT (account_id) DO UPDATE SET
       games_finished = stats.games_finished + 1,
       best_game = GREATEST(stats.best_game, $2),
       worst_game = LEAST(stats.worst_game, $2),
       moons_total = stats.moons_total + $3,
       moons_best_game = GREATEST(stats.moons_best_game, $3),
       points_total = stats.points_total + $2,
       ended_positive = stats.ended_positive + $4,
       ended_negative = stats.ended_negative + $5,
       win_streak_current = CASE WHEN $4 = 1 THEN stats.win_streak_current + 1 ELSE 0 END,
       win_streak_best = GREATEST(stats.win_streak_best,
         CASE WHEN $4 = 1 THEN stats.win_streak_current + 1 ELSE 0 END),
       updated_at = now()`,
    [accountId, finalScore, moonsThisGame, endedPositive, endedNegative]
  );
}

async function getStats(accountId) {
  const { rows } = await pool.query(`SELECT * FROM stats WHERE account_id = $1`, [accountId]);
  const s = rows[0];
  return {
    gamesPlayed: s ? s.games_played : 0,
    gamesFinished: s ? s.games_finished : 0,
    bestTrick: s ? s.best_trick : null,
    worstTrick: s ? s.worst_trick : null,
    bestRound: s ? s.best_round : null,
    worstRound: s ? s.worst_round : null,
    bestGame: s ? s.best_game : null,
    worstGame: s ? s.worst_game : null,
    moonsTotal: s ? s.moons_total : 0,
    moonsBestGame: s ? s.moons_best_game : 0,
    queenSpadesTaken: s ? s.queen_spades_taken : 0,
    avgPoints: s && s.games_finished > 0 ? Math.round((s.points_total / s.games_finished) * 10) / 10 : null,
    endedPositive: s ? s.ended_positive : 0,
    endedNegative: s ? s.ended_negative : 0,
    winStreakBest: s ? s.win_streak_best : 0,
  };
}

module.exports = {
  pool, ensureSchema, toPublic,
  createAccount, findAccountByUsername, findAccountById,
  createSession, findAccountByToken, deleteSession, updateProfile,
  recordGameStarted, recordTrick, recordRound, recordGameFinished, recordQueenTaken, getStats,
};

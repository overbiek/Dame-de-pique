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
  // `stats.mmr`/`stats.placement_games_played` (added when ranked first
  // shipped) are superseded by the dedicated `ranked_stats` table below —
  // left in place as inert legacy columns rather than dropped, but nothing
  // reads or writes them anymore.
  await pool.query(`ALTER TABLE stats ADD COLUMN IF NOT EXISTS mmr INTEGER NOT NULL DEFAULT 1000;`);
  await pool.query(`ALTER TABLE stats ADD COLUMN IF NOT EXISTS placement_games_played INTEGER NOT NULL DEFAULT 0;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranked_stats (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      mmr INTEGER NOT NULL DEFAULT 1000,
      placement_games_played INTEGER NOT NULL DEFAULT 0,
      mmr_highest INTEGER NOT NULL DEFAULT 1000,
      mmr_lowest INTEGER NOT NULL DEFAULT 1000,
      games_played INTEGER NOT NULL DEFAULT 0,
      games_finished INTEGER NOT NULL DEFAULT 0,
      points_total INTEGER NOT NULL DEFAULT 0,
      worst_trick INTEGER,
      best_round INTEGER,
      worst_round INTEGER,
      best_game INTEGER,
      worst_game INTEGER,
      moons_total INTEGER NOT NULL DEFAULT 0,
      moons_best_game INTEGER NOT NULL DEFAULT 0,
      queen_spades_taken INTEGER NOT NULL DEFAULT 0,
      ended_positive INTEGER NOT NULL DEFAULT 0,
      ended_negative INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE ranked_stats ADD COLUMN IF NOT EXISTS games_finished INTEGER NOT NULL DEFAULT 0;`);
  // One-time carry-over of any MMR already earned back when ranked shared
  // the casual `stats` table — safe to run on every boot, ON CONFLICT DO
  // NOTHING makes it a no-op once an account has its own ranked_stats row.
  await pool.query(`
    INSERT INTO ranked_stats (account_id, mmr, placement_games_played, mmr_highest, mmr_lowest)
    SELECT account_id, mmr, placement_games_played, mmr, mmr
    FROM stats
    WHERE mmr <> 1000 OR placement_games_played <> 0
    ON CONFLICT (account_id) DO NOTHING;
  `);
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

// ── Ranked ─────────────────────────────────────────────────────
// Ranked gets its own table, entirely separate from casual `stats` — same
// atomic-upsert, order-independent pattern, but nothing here ever touches
// or is touched by a casual game, and vice versa.

async function getOrCreateRankedProfile(accountId) {
  const { rows } = await pool.query(
    `SELECT mmr, placement_games_played FROM ranked_stats WHERE account_id = $1`,
    [accountId]
  );
  const s = rows[0];
  return {
    mmr: s ? s.mmr : 1000,
    placementGamesPlayed: s ? s.placement_games_played : 0,
  };
}

async function applyRankedMmr(accountId, mmrDelta) {
  const { rows } = await pool.query(
    `INSERT INTO ranked_stats (account_id, mmr, placement_games_played, mmr_highest, mmr_lowest)
     VALUES ($1, GREATEST(0, 1000 + $2), 1, GREATEST(0, 1000 + $2), GREATEST(0, 1000 + $2))
     ON CONFLICT (account_id) DO UPDATE SET
       mmr = GREATEST(0, ranked_stats.mmr + $2),
       placement_games_played = LEAST(5, ranked_stats.placement_games_played + 1),
       mmr_highest = GREATEST(ranked_stats.mmr_highest, GREATEST(0, ranked_stats.mmr + $2)),
       mmr_lowest = LEAST(ranked_stats.mmr_lowest, GREATEST(0, ranked_stats.mmr + $2)),
       updated_at = now()
     RETURNING mmr, placement_games_played`,
    [accountId, mmrDelta]
  );
  const s = rows[0];
  return { mmr: s.mmr, placementGamesPlayed: s.placement_games_played };
}

async function getLeaderboard(limit = 50) {
  const { rows } = await pool.query(
    `SELECT s.account_id, a.nickname, a.avatar, s.mmr, s.placement_games_played
     FROM ranked_stats s JOIN accounts a ON a.id = s.account_id
     ORDER BY s.mmr DESC LIMIT $1`,
    [limit]
  );
  return rows.map(r => ({
    accountId: r.account_id, nickname: r.nickname, avatar: r.avatar, mmr: r.mmr,
    placementGamesPlayed: r.placement_games_played,
  }));
}

// A player's overall position on the full ladder, even when they're well
// outside the top-N slice `getLeaderboard` returns — used to pin a "you"
// row at the bottom when someone isn't visible in the top list.
async function getRankForAccount(accountId) {
  const { rows } = await pool.query(
    `SELECT rnk, mmr, placement_games_played FROM (
       SELECT account_id, mmr, placement_games_played,
              RANK() OVER (ORDER BY mmr DESC) AS rnk
       FROM ranked_stats
     ) t WHERE account_id = $1`,
    [accountId]
  );
  const s = rows[0];
  if (!s) return null;
  return { position: s.rnk, mmr: s.mmr, placementGamesPlayed: s.placement_games_played };
}

async function recordRankedGameStarted(accountId) {
  await pool.query(
    `INSERT INTO ranked_stats (account_id, games_played) VALUES ($1, 1)
     ON CONFLICT (account_id) DO UPDATE SET games_played = ranked_stats.games_played + 1, updated_at = now()`,
    [accountId]
  );
}

async function recordRankedTrick(accountId, trickScore) {
  await pool.query(
    `INSERT INTO ranked_stats (account_id, worst_trick) VALUES ($1, $2)
     ON CONFLICT (account_id) DO UPDATE SET
       worst_trick = LEAST(ranked_stats.worst_trick, $2),
       updated_at = now()`,
    [accountId, trickScore]
  );
}

async function recordRankedRound(accountId, roundDelta) {
  await pool.query(
    `INSERT INTO ranked_stats (account_id, best_round, worst_round) VALUES ($1, $2, $2)
     ON CONFLICT (account_id) DO UPDATE SET
       best_round = GREATEST(ranked_stats.best_round, $2),
       worst_round = LEAST(ranked_stats.worst_round, $2),
       updated_at = now()`,
    [accountId, roundDelta]
  );
}

async function recordRankedQueenTaken(accountId) {
  await pool.query(
    `INSERT INTO ranked_stats (account_id, queen_spades_taken) VALUES ($1, 1)
     ON CONFLICT (account_id) DO UPDATE SET
       queen_spades_taken = ranked_stats.queen_spades_taken + 1,
       updated_at = now()`,
    [accountId]
  );
}

async function recordRankedGameFinished(accountId, finalScore, moonsThisGame) {
  const endedPositive = finalScore > 0 ? 1 : 0;
  const endedNegative = finalScore < 0 ? 1 : 0;
  await pool.query(
    `INSERT INTO ranked_stats (
       account_id, games_finished, best_game, worst_game, moons_total, moons_best_game,
       points_total, ended_positive, ended_negative
     )
     VALUES ($1, 1, $2, $2, $3, $3, $2, $4, $5)
     ON CONFLICT (account_id) DO UPDATE SET
       games_finished = ranked_stats.games_finished + 1,
       best_game = GREATEST(ranked_stats.best_game, $2),
       worst_game = LEAST(ranked_stats.worst_game, $2),
       moons_total = ranked_stats.moons_total + $3,
       moons_best_game = GREATEST(ranked_stats.moons_best_game, $3),
       points_total = ranked_stats.points_total + $2,
       ended_positive = ranked_stats.ended_positive + $4,
       ended_negative = ranked_stats.ended_negative + $5,
       updated_at = now()`,
    [accountId, finalScore, moonsThisGame, endedPositive, endedNegative]
  );
}

async function getRankedStats(accountId) {
  const { rows } = await pool.query(`SELECT * FROM ranked_stats WHERE account_id = $1`, [accountId]);
  const s = rows[0];
  return {
    gamesPlayed: s ? s.games_played : 0,
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
    mmrHighest: s ? s.mmr_highest : null,
    mmrLowest: s ? s.mmr_lowest : null,
  };
}

module.exports = {
  pool, ensureSchema, toPublic,
  createAccount, findAccountByUsername, findAccountById,
  createSession, findAccountByToken, deleteSession, updateProfile,
  recordGameStarted, recordTrick, recordRound, recordGameFinished, recordQueenTaken, getStats,
  getOrCreateRankedProfile, applyRankedMmr, getLeaderboard, getRankForAccount,
  recordRankedGameStarted, recordRankedTrick, recordRankedRound,
  recordRankedQueenTaken, recordRankedGameFinished, getRankedStats,
};

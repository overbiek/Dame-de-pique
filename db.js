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

// New ranked players start in the MIDDLE of Novice, not at the old
// Player/Gold boundary. RANK_TABLE (server.js) has Novice spanning 0-499
// across its three divisions (0 / 167 / 334) with Apprentice starting at
// 500, so the tier's mid-point is 250 — which lands in Novice II either
// way you read "middle of Novice" (the tier's own midpoint, or its middle
// division). Placement games are worth DOUBLE (see applyRankedMmr), which
// is what gets a genuinely skilled new player out of Novice quickly
// rather than grinding up from the bottom at the normal per-game rate.
const RANKED_STARTING_MMR = 250;

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

  // ── Blitz (4- and 8-round casual games) ──
  // Only GAME-level figures need separating: a 4-round final score simply
  // isn't comparable with a 16-round one, so blending them would quietly
  // wreck "best game" and "average points". Per-trick and per-round
  // records are match-length-agnostic and stay in the shared columns
  // above. These live on `stats` rather than in their own table because
  // Blitz is a variant of casual, not a separate ladder like ranked.
  await pool.query(`ALTER TABLE stats ADD COLUMN IF NOT EXISTS blitz_games_played INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE stats ADD COLUMN IF NOT EXISTS blitz_games_finished INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE stats ADD COLUMN IF NOT EXISTS blitz_points_total INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE stats ADD COLUMN IF NOT EXISTS blitz_best_game INTEGER;`);
  await pool.query(`ALTER TABLE stats ADD COLUMN IF NOT EXISTS blitz_worst_game INTEGER;`);
  await pool.query(`ALTER TABLE stats ADD COLUMN IF NOT EXISTS blitz_moons_total INTEGER NOT NULL DEFAULT 0;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranked_stats (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      mmr INTEGER NOT NULL DEFAULT ${RANKED_STARTING_MMR},
      placement_games_played INTEGER NOT NULL DEFAULT 0,
      mmr_highest INTEGER NOT NULL DEFAULT ${RANKED_STARTING_MMR},
      mmr_lowest INTEGER NOT NULL DEFAULT ${RANKED_STARTING_MMR},
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

  // ── Daily Challenge ──
  // One row per account per UTC day. The UNIQUE constraint is the real
  // "one attempt per day" enforcement — the server's pre-check before
  // dealing a hand is only there to give a friendly refusal.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_challenge_scores (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      challenge_date DATE NOT NULL,
      score INTEGER NOT NULL,
      tricks_won INTEGER,
      shot_moon BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (account_id, challenge_date)
    );
  `);
  // Both the leaderboard slice and the "where do I stand" query are
  // (challenge_date, score DESC) — one index covers them at any realistic
  // scale, no separate ranking job needed.
  await pool.query(
    `CREATE INDEX IF NOT EXISTS daily_scores_date_score_idx
       ON daily_challenge_scores(challenge_date, score DESC);`
  );
  // A companion table rather than new columns on `accounts` — streak state
  // is gameplay data, and accounts stays purely identity.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_stats (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      streak INTEGER NOT NULL DEFAULT 0,
      best_streak INTEGER NOT NULL DEFAULT 0,
      days_played INTEGER NOT NULL DEFAULT 0,
      last_played DATE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ── Credits ──────────────────────────────────────────────────
  // A SECOND progression track, deliberately parallel to MMR: credits
  // measure engagement, never skill, and nothing here may ever be read
  // by matchmaking or rank derivation.
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS credit_balance INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS lifetime_credits_earned INTEGER NOT NULL DEFAULT 0;`);
  // Gates ALL casual credit earning to once a day (not just AI games).
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_casual_credit_date DATE;`);
  // Which game claimed the day. Without this the claim is atomic but NOT
  // idempotent: a grant that fails after the claim succeeds would, on
  // trackStat's retry, find the day already taken and silently pay
  // nothing. Storing the reference lets the same game re-claim while a
  // different game on the same day is still refused.
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_casual_credit_ref TEXT;`);
  // The ledger. UNIQUE (account_id, type, reference_id) is what makes a
  // grant SAFE TO RETRY: trackStat re-runs a failed write up to 3 times,
  // and without that constraint a partial failure would pay twice. Every
  // grant is ON CONFLICT DO NOTHING and only moves the balance when a row
  // was actually inserted — same reasoning as recordDailyScore.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      reference_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (account_id, type, reference_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_credit_tx_account ON credit_transactions (account_id, created_at DESC);`);
  // Bought cosmetics. This is the ONE piece of cosmetic state that is
  // stored rather than derived — see the note on getPurchases below.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_purchases (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      price_paid INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, item_id)
    );
  `);

  // ── Friends ──
  // A permanent, shareable code per account rather than username search —
  // no public directory to search or moderate, add a friend by entering
  // a code someone gave you directly. Nullable + a partial unique index
  // (not UNIQUE on the column) so existing accounts from before this
  // shipped don't collide on NULL while they wait to be assigned one
  // lazily on next visit to the Friends tab (getOrCreateFriendCode).
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS friend_code TEXT;`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS accounts_friend_code_idx
       ON accounts(friend_code) WHERE friend_code IS NOT NULL;`
  );
  // Friendship is symmetric, stored as both directions rather than one
  // canonical row — doubles the storage (trivial at this scale) in
  // exchange for every query being a plain "WHERE account_id = $1", no
  // OR-of-both-columns anywhere.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friendships (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      friend_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, friend_id)
    );
  `);

  // ── Achievements ──
  // A THIRD, mode-agnostic counter table, deliberately not new columns on
  // `stats` or `ranked_stats`. Those two are strictly separated pipelines
  // (casual writes never touch ranked and vice versa), and an achievement
  // like "win 25 games" is meant to count every game you play in any
  // mode — folding it into either table would either break that
  // separation or need the same counter kept in two places and summed at
  // read time. Nothing in here is displayed as a statistic; it exists
  // only to be compared against ACHIEVEMENTS' thresholds in server.js.
  //
  // Deliberately NOT stored here: a "peak MMR" counter. `ranked_stats`
  // already tracks mmr_highest, and the brief for this system is explicit
  // that rank must never be computed or duplicated a second time — the
  // High Roller achievement reads that column directly (see
  // getAchievementStats' LEFT JOIN).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS achievement_stats (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      games_completed INTEGER NOT NULL DEFAULT 0,
      games_completed_full INTEGER NOT NULL DEFAULT 0,
      games_won INTEGER NOT NULL DEFAULT 0,
      games_won_positive INTEGER NOT NULL DEFAULT 0,
      ranked_games_won INTEGER NOT NULL DEFAULT 0,
      queens_taken INTEGER NOT NULL DEFAULT 0,
      moons_total INTEGER NOT NULL DEFAULT 0,
      four_suit_games INTEGER NOT NULL DEFAULT 0,
      dealer_rounds INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // ── Equipped cosmetics ──
  // One row per account holding only what's CURRENTLY equipped. What's
  // *unlocked* is never stored: it's always re-derived from
  // achievement_stats against the thresholds in server.js, so retuning a
  // threshold can't leave stale unlock rows behind, and there's no way
  // for the two to disagree. The columns are plain TEXT holding cosmetic
  // IDs from server.js's COSMETICS registry; an ID that no longer exists
  // (or is no longer unlocked) is filtered out on read rather than
  // migrated, so removing a cosmetic is safe.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_cosmetics (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      scene TEXT,
      card_front TEXT,
      crest TEXT,
      title TEXT,
      seen_achievements TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Added after the table first shipped. NULL is meaningful here rather
  // than a missing value: it means "follow my rank automatically", which
  // is what filterEquipped resolves to the highest unlocked set.
  await pool.query(`ALTER TABLE player_cosmetics ADD COLUMN IF NOT EXISTS rank_set TEXT;`);
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

// ── Friends ────────────────────────────────────────────────────
// No confusing chars — same alphabet makeCode() uses for room codes in
// server.js, kept independent here since db.js has no access to that
// module's helpers and shouldn't need it for one constant.
const FRIEND_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomFriendCode() {
  let out = '';
  for (let i = 0; i < 6; i++) out += FRIEND_CODE_ALPHABET[Math.floor(Math.random() * FRIEND_CODE_ALPHABET.length)];
  return out;
}

// Lazy assignment rather than at signup: every account gets one the first
// time it's actually needed (visiting the Friends tab), which also means
// accounts created before this shipped pick one up automatically instead
// of needing a migration pass. The UPDATE ... WHERE friend_code IS NULL
// is the real safety net against a concurrent double-assignment (two tabs
// open at once); the retry loop only exists for the astronomically rare
// case of the random code itself colliding with someone else's.
async function getOrCreateFriendCode(accountId) {
  const { rows } = await pool.query(`SELECT friend_code FROM accounts WHERE id = $1`, [accountId]);
  if (rows[0] && rows[0].friend_code) return rows[0].friend_code;
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomFriendCode();
    try {
      const { rows: updated } = await pool.query(
        `UPDATE accounts SET friend_code = $2 WHERE id = $1 AND friend_code IS NULL RETURNING friend_code`,
        [accountId, code]
      );
      if (updated[0]) return updated[0].friend_code;
      const { rows: recheck } = await pool.query(`SELECT friend_code FROM accounts WHERE id = $1`, [accountId]);
      if (recheck[0] && recheck[0].friend_code) return recheck[0].friend_code;
    } catch (e) {
      if (e.code !== '23505') throw e; // unique_violation on the code itself — try another
    }
  }
  throw new Error('Could not generate a unique friend code');
}

async function findAccountByFriendCode(code) {
  const { rows } = await pool.query(
    `SELECT * FROM accounts WHERE friend_code = $1`,
    [String(code || '').trim().toUpperCase()]
  );
  return rows[0] || null;
}

async function addFriend(accountId, friendId) {
  if (accountId === friendId) return;
  await pool.query(
    `INSERT INTO friendships (account_id, friend_id) VALUES ($1,$2),($2,$1)
     ON CONFLICT DO NOTHING`,
    [accountId, friendId]
  );
}

async function removeFriend(accountId, friendId) {
  await pool.query(
    `DELETE FROM friendships WHERE (account_id = $1 AND friend_id = $2) OR (account_id = $2 AND friend_id = $1)`,
    [accountId, friendId]
  );
}

async function areFriends(accountId, friendId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM friendships WHERE account_id = $1 AND friend_id = $2`,
    [accountId, friendId]
  );
  return rows.length > 0;
}

async function getFriends(accountId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.nickname, a.avatar
     FROM friendships f JOIN accounts a ON a.id = f.friend_id
     WHERE f.account_id = $1
     ORDER BY a.nickname ASC`,
    [accountId]
  );
  return rows.map(r => ({ id: r.id, nickname: r.nickname, avatar: r.avatar }));
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

// ── Blitz (short casual games) ─────────────────────────────────
// Same atomic-upsert shape as the casual writes above, just landing in
// the blitz_* columns so a 4-round score can't distort a 16-round average.

async function recordBlitzGameStarted(accountId) {
  await pool.query(
    `INSERT INTO stats (account_id, blitz_games_played) VALUES ($1, 1)
     ON CONFLICT (account_id) DO UPDATE SET
       blitz_games_played = stats.blitz_games_played + 1, updated_at = now()`,
    [accountId]
  );
}

async function recordBlitzGameFinished(accountId, finalScore, moonsThisGame) {
  await pool.query(
    `INSERT INTO stats (
       account_id, blitz_games_finished, blitz_best_game, blitz_worst_game,
       blitz_points_total, blitz_moons_total
     )
     VALUES ($1, 1, $2, $2, $2, $3)
     ON CONFLICT (account_id) DO UPDATE SET
       blitz_games_finished = stats.blitz_games_finished + 1,
       blitz_best_game = GREATEST(stats.blitz_best_game, $2),
       blitz_worst_game = LEAST(stats.blitz_worst_game, $2),
       blitz_points_total = stats.blitz_points_total + $2,
       blitz_moons_total = stats.blitz_moons_total + $3,
       updated_at = now()`,
    [accountId, finalScore, moonsThisGame]
  );
}

// ── Daily Challenge ────────────────────────────────────────────

// ON CONFLICT DO NOTHING, not DO UPDATE: a second submission for the same
// day must never overwrite the first one's score.
async function recordDailyScore(accountId, date, score, tricksWon, shotMoon) {
  await pool.query(
    `INSERT INTO daily_challenge_scores (account_id, challenge_date, score, tricks_won, shot_moon)
     VALUES ($1, $2::date, $3, $4, $5)
     ON CONFLICT (account_id, challenge_date) DO NOTHING`,
    [accountId, date, score, tricksWon, !!shotMoon]
  );
}

async function getDailyScore(accountId, date) {
  const { rows } = await pool.query(
    `SELECT score, tricks_won, shot_moon FROM daily_challenge_scores
     WHERE account_id = $1 AND challenge_date = $2::date`,
    [accountId, date]
  );
  const r = rows[0];
  return r ? { score: r.score, tricksWon: r.tricks_won, shotMoon: r.shot_moon } : null;
}

// Extends the streak when yesterday was played, restarts it at 1 after a
// gap, and is a no-op if today is already banked — all decided inside the
// one statement so two writes landing at once can't double-count.
async function bumpDailyStreak(accountId, date) {
  const { rows } = await pool.query(
    `INSERT INTO daily_stats (account_id, streak, best_streak, days_played, last_played)
     VALUES ($1, 1, 1, 1, $2::date)
     ON CONFLICT (account_id) DO UPDATE SET
       streak = CASE
         WHEN daily_stats.last_played = $2::date     THEN daily_stats.streak
         WHEN daily_stats.last_played = $2::date - 1 THEN daily_stats.streak + 1
         ELSE 1 END,
       best_streak = GREATEST(daily_stats.best_streak, CASE
         WHEN daily_stats.last_played = $2::date     THEN daily_stats.streak
         WHEN daily_stats.last_played = $2::date - 1 THEN daily_stats.streak + 1
         ELSE 1 END),
       days_played = daily_stats.days_played
         + CASE WHEN daily_stats.last_played = $2::date THEN 0 ELSE 1 END,
       last_played = $2::date,
       updated_at = now()
     RETURNING streak, best_streak, days_played`,
    [accountId, date]
  );
  const r = rows[0];
  return { streak: r.streak, bestStreak: r.best_streak, daysPlayed: r.days_played };
}

// The stored `streak` is only still live if the last play was today or
// yesterday — otherwise it has already lapsed and should read 0, even
// though the row still holds its old value until the next play rewrites it.
async function getDailyStreak(accountId, today) {
  const { rows } = await pool.query(
    `SELECT streak, best_streak, days_played,
            (last_played = $2::date)     AS played_today,
            (last_played = $2::date - 1) AS played_yesterday
     FROM daily_stats WHERE account_id = $1`,
    [accountId, today]
  );
  const r = rows[0];
  if (!r) return { streak: 0, bestStreak: 0, daysPlayed: 0 };
  const live = r.played_today || r.played_yesterday;
  return { streak: live ? r.streak : 0, bestStreak: r.best_streak, daysPlayed: r.days_played };
}

async function getDailyLeaderboard(date, limit = 25) {
  const { rows } = await pool.query(
    `SELECT d.account_id, a.nickname, a.avatar, d.score, d.tricks_won, d.shot_moon
     FROM daily_challenge_scores d JOIN accounts a ON a.id = d.account_id
     WHERE d.challenge_date = $1::date
     ORDER BY d.score DESC, d.created_at ASC
     LIMIT $2`,
    [date, limit]
  );
  return rows.map(r => ({
    accountId: r.account_id, nickname: r.nickname, avatar: r.avatar,
    score: r.score, tricksWon: r.tricks_won, shotMoon: r.shot_moon,
  }));
}

// Where one player placed on a given day, plus how many played at all —
// used to pin a "you" row when they're outside the top slice.
async function getDailyStanding(accountId, date) {
  const { rows } = await pool.query(
    `SELECT rnk, score, total FROM (
       SELECT account_id, score,
              RANK() OVER (ORDER BY score DESC) AS rnk,
              COUNT(*) OVER () AS total
       FROM daily_challenge_scores WHERE challenge_date = $1::date
     ) t WHERE account_id = $2`,
    [date, accountId]
  );
  const r = rows[0];
  if (!r) return null;
  return { position: Number(r.rnk), score: r.score, entries: Number(r.total) };
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
    blitzGamesPlayed: s ? s.blitz_games_played : 0,
    blitzGamesFinished: s ? s.blitz_games_finished : 0,
    blitzBestGame: s ? s.blitz_best_game : null,
    blitzWorstGame: s ? s.blitz_worst_game : null,
    blitzMoonsTotal: s ? s.blitz_moons_total : 0,
    blitzAvgPoints: s && s.blitz_games_finished > 0
      ? Math.round((s.blitz_points_total / s.blitz_games_finished) * 10) / 10
      : null,
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
    mmr: s ? s.mmr : RANKED_STARTING_MMR,
    placementGamesPlayed: s ? s.placement_games_played : 0,
  };
}

// Placement games (the first 5) apply DOUBLE the MMR delta, so a new
// player's first handful of results move them roughly to where they
// belong instead of the normal per-game rate crawling them there over
// dozens of games. Whether THIS game is still a placement game is read
// from placement_games_played as it stood BEFORE this game — `FOR UPDATE`
// locks that row for the duration of the transaction, so two ranked
// results finishing for the same account at once can't both read the
// pre-increment count and both apply double.
async function applyRankedMmr(accountId, mmrDelta) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      `SELECT placement_games_played FROM ranked_stats WHERE account_id = $1 FOR UPDATE`,
      [accountId]
    );
    // No row yet means this is this account's very first ranked result,
    // which is definitionally a placement game.
    const wasPlacement = existing.length ? existing[0].placement_games_played < 5 : true;
    const appliedDelta = mmrDelta * (wasPlacement ? 2 : 1);
    const { rows } = await client.query(
      `INSERT INTO ranked_stats (account_id, mmr, placement_games_played, mmr_highest, mmr_lowest)
       VALUES ($1, GREATEST(0, $3 + $2), 1, GREATEST(0, $3 + $2), GREATEST(0, $3 + $2))
       ON CONFLICT (account_id) DO UPDATE SET
         mmr = GREATEST(0, ranked_stats.mmr + $2),
         placement_games_played = LEAST(5, ranked_stats.placement_games_played + 1),
         mmr_highest = GREATEST(ranked_stats.mmr_highest, GREATEST(0, ranked_stats.mmr + $2)),
         mmr_lowest = LEAST(ranked_stats.mmr_lowest, GREATEST(0, ranked_stats.mmr + $2)),
         updated_at = now()
       RETURNING mmr, placement_games_played`,
      [accountId, appliedDelta, RANKED_STARTING_MMR]
    );
    await client.query('COMMIT');
    return { mmr: rows[0].mmr, placementGamesPlayed: rows[0].placement_games_played };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
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

// ── Achievements ───────────────────────────────────────────────
// Same atomic-upsert discipline as every other write in this file, so two
// games finishing at the same instant for the same account can't lose an
// increment. Every one of these is called through server.js's trackStat(),
// which retries — that's why they must stay purely additive and
// order-independent.

// One call per finished game, taking every per-game flag at once rather
// than one query per counter — a game end already fans out to the casual
// or ranked writer, and this adds exactly one more round-trip instead of
// six.
async function recordAchievementGame(accountId, {
  completed = 0, completedFull = 0, won = 0, wonPositive = 0,
  rankedWon = 0, moons = 0, fourSuit = 0,
} = {}) {
  await pool.query(
    `INSERT INTO achievement_stats (
       account_id, games_completed, games_completed_full, games_won,
       games_won_positive, ranked_games_won, moons_total, four_suit_games
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (account_id) DO UPDATE SET
       games_completed = achievement_stats.games_completed + $2,
       games_completed_full = achievement_stats.games_completed_full + $3,
       games_won = achievement_stats.games_won + $4,
       games_won_positive = achievement_stats.games_won_positive + $5,
       ranked_games_won = achievement_stats.ranked_games_won + $6,
       moons_total = achievement_stats.moons_total + $7,
       four_suit_games = achievement_stats.four_suit_games + $8,
       updated_at = now()`,
    [accountId, completed, completedFull, won, wonPositive, rankedWon, moons, fourSuit]
  );
}

// Counted across every mode, unlike stats.queen_spades_taken /
// ranked_stats.queen_spades_taken which are deliberately mode-split.
async function recordAchievementQueen(accountId) {
  await pool.query(
    `INSERT INTO achievement_stats (account_id, queens_taken) VALUES ($1, 1)
     ON CONFLICT (account_id) DO UPDATE SET
       queens_taken = achievement_stats.queens_taken + 1, updated_at = now()`,
    [accountId]
  );
}

async function recordDealerRound(accountId) {
  await pool.query(
    `INSERT INTO achievement_stats (account_id, dealer_rounds) VALUES ($1, 1)
     ON CONFLICT (account_id) DO UPDATE SET
       dealer_rounds = achievement_stats.dealer_rounds + 1, updated_at = now()`,
    [accountId]
  );
}

// mmrPeak comes straight off ranked_stats rather than being mirrored into
// achievement_stats — see the table comment in ensureSchema.
async function getAchievementStats(accountId) {
  const { rows } = await pool.query(
    `SELECT a.*, r.mmr_highest
     FROM (SELECT $1::int AS account_id) k
     LEFT JOIN achievement_stats a ON a.account_id = k.account_id
     LEFT JOIN ranked_stats r ON r.account_id = k.account_id`,
    [accountId]
  );
  const s = rows[0] || {};
  return {
    gamesCompleted: s.games_completed || 0,
    gamesCompletedFull: s.games_completed_full || 0,
    gamesWon: s.games_won || 0,
    gamesWonPositive: s.games_won_positive || 0,
    rankedGamesWon: s.ranked_games_won || 0,
    queensTaken: s.queens_taken || 0,
    moonsTotal: s.moons_total || 0,
    fourSuitGames: s.four_suit_games || 0,
    dealerRounds: s.dealer_rounds || 0,
    mmrPeak: s.mmr_highest || 0,
  };
}

// ── Equipped cosmetics ─────────────────────────────────────────
// seen_achievements is a comma-joined ID list, not a jsonb array or its
// own table: it's a write-once-per-unlock marker whose only job is to
// stop the unlock celebration firing twice, so it never needs to be
// queried by element.
async function getCosmetics(accountId) {
  const { rows } = await pool.query(
    `SELECT scene, card_front, crest, title, rank_set, seen_achievements
     FROM player_cosmetics WHERE account_id = $1`,
    [accountId]
  );
  const c = rows[0];
  return {
    scene: (c && c.scene) || null,
    cardFront: (c && c.card_front) || null,
    crest: (c && c.crest) || null,
    title: (c && c.title) || null,
    rankSet: (c && c.rank_set) || null,
    seen: c && c.seen_achievements ? c.seen_achievements.split(',').filter(Boolean) : [],
  };
}

// COALESCE against the incoming value being NULL would make "unequip"
// impossible, so an explicit empty string is the unequip signal and is
// stored as NULL. The caller (server.js) has already validated every ID
// against what the account has actually unlocked.
async function saveCosmetics(accountId, { scene, cardFront, crest, title, rankSet }) {
  const norm = v => (v === undefined ? undefined : (v || null));
  const s = norm(scene), cf = norm(cardFront), cr = norm(crest), t = norm(title), rs = norm(rankSet);
  await pool.query(
    `INSERT INTO player_cosmetics (account_id, scene, card_front, crest, title, rank_set)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (account_id) DO UPDATE SET
       scene = CASE WHEN $7 THEN $2 ELSE player_cosmetics.scene END,
       card_front = CASE WHEN $8 THEN $3 ELSE player_cosmetics.card_front END,
       crest = CASE WHEN $9 THEN $4 ELSE player_cosmetics.crest END,
       title = CASE WHEN $10 THEN $5 ELSE player_cosmetics.title END,
       rank_set = CASE WHEN $11 THEN $6 ELSE player_cosmetics.rank_set END,
       updated_at = now()`,
    [accountId, s ?? null, cf ?? null, cr ?? null, t ?? null, rs ?? null,
     s !== undefined, cf !== undefined, cr !== undefined, t !== undefined, rs !== undefined]
  );
  return getCosmetics(accountId);
}

// Adds IDs to the "already celebrated" set. Union rather than replace, so
// two tabs open at once can't clobber each other's markers.
async function markAchievementsSeen(accountId, ids) {
  if (!ids || !ids.length) return;
  const joined = ids.join(',');
  await pool.query(
    `INSERT INTO player_cosmetics (account_id, seen_achievements) VALUES ($1, $2)
     ON CONFLICT (account_id) DO UPDATE SET
       seen_achievements = (
         SELECT string_agg(DISTINCT x, ',')
         FROM unnest(string_to_array(
           COALESCE(NULLIF(player_cosmetics.seen_achievements, ''), $2) || ',' || $2, ','
         )) AS x
         WHERE x <> ''
       ),
       updated_at = now()`,
    [accountId, joined]
  );
}

// ── Credits ──────────────────────────────────────────────────────
// Every grant goes through here. Returns the new balance, or null when
// the grant was a duplicate (the ledger's UNIQUE constraint caught a
// retry) so the caller can tell "paid" from "already paid".
// referenceId must be stable for a given payable event — a game's
// code+startedAt, a daily's date — which is exactly what makes the
// retry safe.
async function grantCredits(accountId, amount, type, referenceId) {
  if (!accountId || !amount) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO credit_transactions (account_id, amount, type, reference_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
      [accountId, amount, type, String(referenceId)]
    );
    if (!ins.rows.length) { await client.query('ROLLBACK'); return null; }
    const { rows } = await client.query(
      `UPDATE accounts SET credit_balance = credit_balance + $2,
              lifetime_credits_earned = lifetime_credits_earned + GREATEST($2,0)
       WHERE id = $1 RETURNING credit_balance, lifetime_credits_earned`,
      [accountId, amount]
    );
    await client.query('COMMIT');
    return { balance: rows[0].credit_balance, lifetime: rows[0].lifetime_credits_earned };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
}

async function getCredits(accountId) {
  const { rows } = await pool.query(
    `SELECT credit_balance, lifetime_credits_earned FROM accounts WHERE id = $1`, [accountId]);
  if (!rows.length) return { balance: 0, lifetime: 0 };
  return { balance: rows[0].credit_balance, lifetime: rows[0].lifetime_credits_earned };
}

// Claims TODAY's single casual credit slot for one specific game.
// The conditional WHERE makes it atomic, so two casual games finishing at
// the same instant can't both be paid; matching on the stored reference
// makes it idempotent, so trackStat retrying the SAME game still gets its
// payout. Returns true if this game holds today's slot.
async function claimCasualCreditDay(accountId, date, referenceId) {
  const { rowCount } = await pool.query(
    `UPDATE accounts SET last_casual_credit_date = $2::date, last_casual_credit_ref = $3
     WHERE id = $1 AND (last_casual_credit_date IS NULL
                     OR last_casual_credit_date <> $2::date
                     OR last_casual_credit_ref = $3)`,
    [accountId, date, String(referenceId)]
  );
  return rowCount > 0;
}

// Buys an item. Balance can never go negative: the guard is in the WHERE,
// so an over-spend updates no row instead of writing a negative balance.
// Returns {ok, balance} or {ok:false, reason}.
async function purchaseItem(accountId, itemId, price) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query(
      `INSERT INTO player_purchases (account_id, item_id, price_paid)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING item_id`,
      [accountId, itemId, price]
    );
    if (!owned.rows.length) { await client.query('ROLLBACK'); return { ok: false, reason: 'owned' }; }
    const paid = await client.query(
      `UPDATE accounts SET credit_balance = credit_balance - $2
       WHERE id = $1 AND credit_balance >= $2 RETURNING credit_balance`,
      [accountId, price]
    );
    if (!paid.rows.length) { await client.query('ROLLBACK'); return { ok: false, reason: 'funds' }; }
    await client.query(
      `INSERT INTO credit_transactions (account_id, amount, type, reference_id)
       VALUES ($1,$2,'spend',$3) ON CONFLICT DO NOTHING`,
      [accountId, -price, itemId]
    );
    await client.query('COMMIT');
    return { ok: true, balance: paid.rows[0].credit_balance };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
}

// The one piece of cosmetic availability that is STORED rather than
// re-derived. Everything else (achievement crests, titles, rank sets) is
// still computed fresh from achievement_stats every time, so retuning a
// threshold still takes effect immediately for everyone — a bought item
// simply ORs into that result and can never be revoked by a retune.
async function getPurchases(accountId) {
  const { rows } = await pool.query(
    `SELECT item_id FROM player_purchases WHERE account_id = $1`, [accountId]);
  return rows.map(r => r.item_id);
}

module.exports = {
  pool, ensureSchema, toPublic,
  createAccount, findAccountByUsername, findAccountById,
  createSession, findAccountByToken, deleteSession, updateProfile,
  getOrCreateFriendCode, findAccountByFriendCode, addFriend, removeFriend, areFriends, getFriends,
  recordGameStarted, recordTrick, recordRound, recordGameFinished, recordQueenTaken, getStats,
  recordBlitzGameStarted, recordBlitzGameFinished,
  recordDailyScore, getDailyScore, bumpDailyStreak, getDailyStreak,
  getDailyLeaderboard, getDailyStanding,
  getOrCreateRankedProfile, applyRankedMmr, getLeaderboard, getRankForAccount,
  recordRankedGameStarted, recordRankedTrick, recordRankedRound,
  recordRankedQueenTaken, recordRankedGameFinished, getRankedStats,
  recordAchievementGame, recordAchievementQueen, recordDealerRound, getAchievementStats,
  getCosmetics, saveCosmetics, markAchievementsSeen,
  grantCredits, getCredits, claimCasualCreditDay, purchaseItem, getPurchases,
};

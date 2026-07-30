# Dame de Pique — Online Multiplayer

A real-time multiplayer card game built with Node.js + Socket.io.

## How to deploy on Railway (free, ~5 minutes)

### 1. Get the code on GitHub
1. Create a free account at https://github.com
2. Create a new repository (e.g. `dame-de-pique`)
3. Upload these files:
   - `server.js`
   - `package.json`
   - `public/index.html`

### 2. Deploy on Railway
1. Go to https://railway.app and sign up (free)
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your `dame-de-pique` repository
4. Railway auto-detects Node.js and runs `npm start`
5. Click **"Generate Domain"** in the Settings tab
6. Your game is live at `https://your-app.up.railway.app`

### 3. Play with friends
- Share the URL with up to 3 friends
- One person creates a room and shares the 5-letter room code
- Others join with the code
- The host can set any empty seat to AI

## Local development
```bash
npm install
npm start
# Open http://localhost:3000
```

## Game rules summary
- 4 players, 16 rounds
- Each trick won: **+10 points**
- Hearts: **−card value** (2♥=−2 … A♥=−14)
- Queen of Spades: **−26 points**
- Shoot the moon (all hearts + Q♠): **+60** for shooter, **−20** for others
- Cards pass: left → right → across → keep, repeat
- Round 1 only: hearts and Q♠ cannot be led until broken
- Highest score after 16 rounds wins

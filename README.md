# Dame de Pique — online multiplayer

Node.js + Socket.io. Installable on Android as a PWA.

## Files

```
package.json
server.js
public/index.html
public/manifest.json
public/sw.js
public/icon-192.png
public/icon-512.png
public/icon-maskable-512.png
public/apple-touch-icon.png
```

## Updating your Railway deployment

Push these files to your `dame-de-pique` GitHub repo (replacing the old
`server.js` and `public/index.html`, adding the rest). Railway redeploys
automatically within about a minute.

## Installing on Android

1. Open your Railway URL in **Chrome** on the phone.
2. Either tap **Install as an app** on the home screen, or use
   Chrome's ⋮ menu → **Add to Home screen**.
3. It installs with an icon, launches full screen with no browser bar,
   and behaves like a normal app.

On iPhone: Safari → Share → **Add to Home Screen**.

## Local development

```bash
npm install
npm start
# http://localhost:3000
```

## Rules implemented

| Rule | Value |
|---|---|
| Trick won | **+10** |
| Hearts | **−face value** (2♥ = −2 … A♥ = −14) |
| Queen of Spades | **−26** |
| Shoot the moon | **+60** shooter, **−20** each other player |
| Cards passed | **2** per round |
| Pass rotation | left → right → across → keep |
| Rounds | **16**, highest score wins |
| Lead restriction | Round 1 only: no ♥ or ♠Q lead until broken |
| Dealer | Cut for first dealer, then rotates clockwise |

Each round is exactly zero-sum: 13 tricks × 10 = 130, and the penalties
total −130 (hearts −104, ♠Q −26). Shooting the moon is zero-sum too
(+60 − 20×3). Useful sanity check if you ever change the scoring.

## Notes

- Games live in server memory, so a Railway restart clears any in-progress game.
- Players reconnect automatically after backgrounding the app or losing signal.
- Rooms idle for 3 hours are swept automatically.

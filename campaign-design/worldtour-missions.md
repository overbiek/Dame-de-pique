# World Tour: mission types (design, decided 2026-10-31)

Status: **design only, nothing built.** Decisions are Robin's; the Beat the Champion rules are confirmed (section 4), items marked OPEN in sections 2-3 are superseded by it.
Context: `WORLDTOUR.md` (open question 4, "Which mission types go in"). Method for building the level data: the xlsx's `Formulas & Method` sheet.

## 1. The mission set

| Type | Used on | Status |
|---|---|---|
| Score (reach a minimum score) | ordinary tables | exists |
| Clean Hand (no penalty points) | mission tables | exists |
| Avoid the Queen of Spades | mission tables | exists |
| Trick Count (win at least N tricks) | mission tables | exists |
| **Suit Void** | **not used in World Tour** | decided: left out |
| **Beat the Champion** | **boss tables only** | new, designed below |

Per decade the House of Diamonds shape still works: 6 score + 3 mission + 1 boss. With Suit Void gone the 3 mission slots rotate through Clean Hand, Avoid Q and Trick Count (so each appears about 3 times per 10 countries' worth of rotation instead of four types sharing). The engine code for `suitVoid` stays; World Tour data simply never uses it.

Still on the shortlist, not decided: Partner pair, local-game skins (Schuppen Dam Jagen, Hjerterfri, Kierki).

## 2. Beat the Champion (boss tables)

**Idea (Robin):** at a boss table the player has to hand the country champion (one specific seat) the most minus points. The harder version: the player also has to win the table while the champion ends last.

**Reading used here** (OPEN, confirm): the two halves are the two rewards.
- **Clear**: the champion finishes **last at the table**, i.e. the lowest score, over the whole fight (all hands pooled, like every other boss).
- **Gold**: clear **and** the player finishes **first** (highest total).

Alternative reading: either condition clears. I think the split above is better, because it gives gold its usual "rarer, harder" meaning and needs no new reward logic.

### Rules to settle (OPEN, with a recommendation)
1. **Ties for last.** Recommend: a tie for last counts as clear (the codebase already treats ties generously: wins, placements). Consequence: a moon by the player (+60 / -20 / -20 / -20) clears it. That seems right, a moon is a feat. Gold still needs the player strictly first.
2. **Which table.** Recommend table 10 (Keeper's Table): the champion is crowned at table 9 and is a named seat at table 10 with two Great Eight members. Table 9 ("champion is chosen") stays an ordinary level. Say if table 9 should also use it.
3. **Margin.** Optional `minMargin`: the champion must be last **by at least M points** over the next-lowest player. This is the difficulty dial (see section 3). Gold may use a larger margin or none.

### What the engine needs (nothing here exists yet)
- New objective shape in `evaluateCampaignObjective` (server.js), e.g. `{type:'beatChampion', minMargin, goldMargin?}`. It reads **all four** `G.players[i].score`, not just seat 0. The champion's seat comes from the chapter roster's `bossSeat` (the same seat `campaignCharId` marks), so no new seat field.
- Same place for `submitCampaignLevelResult`'s `metric`: use the margin (champion's gap to the next-lowest), so the result screen can say how close it was.
- Client: add the case to `campaignObjectiveParts` (level-detail popup text, leave-hand modal, result screen). Mark the champion on the roster rail (a small crown or target ring) so the player always knows whose points they are feeding. The score is already frozen between rounds in the rail, which is exactly the number that matters.
- Level data in World Tour's own data file (not `CAMPAIGN_LEVELS`). The deck code already pools hands and fixes only the player's hand; the other 39 cards are seeded per round, so the champion's hand is reproducible too and the level is a perfect-information puzzle.
- No AI change needed. Opponents, including the champion, play their normal game (they try to avoid penalties), which is what makes the mission a real fight. The existing moon-defence logic means the AIs already stop the player's moon.

### Why it plays well
- It is natural Hearts play: spite. Pass penalty cards in the direction that reaches the champion, lead suits he must follow high, dump the Queen and hearts when he is winning the trick.
- It pulls against your own score: the best gold run needs you to also stay clean.
- The champion's own moon attempt becomes a threat to watch for: his +60 fails the mission outright, so the player has a reason to take a dirty trick to break it (the AI already does this for the player's benefit in the other direction).

## 3. Calibrating it (the part that needs real runs)

Score levels have a natural dial (the target number). Beat the Champion does not, like Clean Hand and Avoid Q: the clear rate is mostly fixed by the hand and the champion's seat. So the method is the xlsx's goal-type method:
1. **A goal-seeking bot for seat 0** (does not exist yet): same engine, but its card choice and pass choice add a bonus for penalty points that land on the champion's seat and a penalty for points it takes itself. Needed because the normal AI at seat 0 does not try this, the same reason Clean Hand / Avoid Q used a heuristic proxy for shortlisting.
2. **Search seeds**: ~1200 candidate seeds, cheap proxy ranking, quick real-AI probe on the best, then a confirmation batch.
3. **Dial = margin**, plus seed choice. Pick the margin whose measured clear rate is closest to the aim, scanning observed values (not a rank-quantile: margins cluster on mass points like scores do).
4. **Verify on a separate, larger batch** (150-300 trials; 100+ for long bosses). Report that number, not the selection batch.
5. **Gold** = clear and player first; check its measured rate and that it is not equal to the clear rate. If the champion's last place nearly always comes with the player's win on a seed (they can be correlated), raise gold's margin or drop that seed.

Aim rates: bosses already sit about 15 points below the ordinary curve in the xlsx, so for World Tour bosses start from the Diamonds boss aims (roughly 3-8% clear) and move later. Note the chance baseline is 25% for "champion last" with no steering, so the dial is mostly the **margin**: a margin of 0 is much easier than a margin of 20.

Things that will move the numbers and must be fixed per level in the data:
- **Champion seat** (left, across, right): decides which pass direction hands him cards directly. In a 4-hand boss that is exactly one of the four hands (bosses keep the standard L/R/A/K cycle, see WORLDTOUR.md "Passing"), in an 8-16-hand boss it is every fourth hand. Pick the seat per country on purpose, and write it in the level data.
- **Hand count**: more hands pool more variance away, so skill matters more. Suggest early countries 4 hands, later ones longer, in line with the Diamonds boss ladder.
- **Moon on the fixed hands**: a seed where either the player or the champion can run is dangerous (it flips the result). Reject or flag those seeds.

## 4. Confirmed by Robin (2026-10-31) and still open
Confirmed (Robin: "Yes, that's it" to the reading below plus the recommended rules):
1. Clear = champion last; gold = clear and you also finish first.
2. Ties for last count as clear (a player moon clears).
3. Table 10 (Keeper's Table) only; table 9 stays ordinary.
4. Margin dial is used for calibration.

Still open:
5. Mission rotation on the other tables (3 slots, 3 types): fixed order, or weighted toward Trick Count / Clean Hand?
6. Champion seat per country, and boss hand counts per country (section 3).

## 4b. Decision 2026-11-01: every boss is 8 hands
Robin: boss hand count is always 8 (two L/R/A/K cycles), for every country. This settles open item 6's hand count. The champion seat per country is still to be chosen. The Europe bosses in section 5 were regenerated at 8 hands.

## 5. Europe levels 401-500 generated (2026-11-01, final run)
Data: `worldtour-levels/europe-levels.json` (best attempt per level; CAMPAIGN_CHAPTERS-like fields plus `handList` (8 hands) for bosses, measured rates, `inBand`) and `europe-levels.csv`; readable list in `worldtour-europe-level-list.md`. Code: `engine.js` (real server.js headless), `play.js`, `gen.js`, `run.js` (`node run.js 6 1 100`), `reuse.js`, `retry.js`, `assemble.js`. Raw attempts in `results/`; superseded runs are archived in `results_old_40to12/`, `results_wrongpass/`, `results_4hand_bosses/`, `results_retry_unused/`. **Wired into the game (2026-11-01):** `server.js` has a generated block (`make_server_block.py`) and `beatChampion` in `evaluateCampaignObjective`.

Structure: country = 10 tables each. Table 10 = Beat the Champion, **8 hands** (L/R/A/K twice), champion seat rotating `[2,1,3,2,1,3,2,1,3,2]` by country. Tables 3 and 6 = missions rotating Clean Hand / Avoid Queen / Trick Count. The rest are score levels. **Pass order (Robin): single-hand levels run Keep, Left, Right, Across continuously through the country with bosses NOT counted** (table 1 keep, 2 left, 3 right, 4 across, 5 keep ... 9 keep, 10 boss, 11 left, 12 right ...).

Aim (Robin): clear 15% at table 1 easing linearly to 10% by table 80, 10% for 80-100 (mean about 12%), same curve for every kind. Band = aim +/- 4 points. Verification batch: 250 games, bosses 100; the verification number is the one stored.

Method of the final run: 81 of the 90 single-hand slots were filled by REUSING verified puzzles from the earlier (wrong pass order) run: same hand, seed and direction, shifted to a slot with that direction and kind whose band fits its measured clear rate (`reuse.js`). The other 9 single-hand levels (403 416 441 445 458 483 486 493 496) and all 10 bosses were generated new; out-of-band results were re-rolled with fresh seeds (up to 5 attempts, then a further round for the four stragglers).

Result: **97/100 in band**, mean clear 12.0% (aim 12.0%), mean gold 3.6%. Score 70/70, boss 9/10, missions 18/20 (kind counts: 7 clean hand, 7 avoid queen, 6 trick count).
Accepted as is by Robin: **403** (clean hand, clear 9% vs aim 15%), **410** (boss, 19% vs 14%), **496** (avoid Queen, clear 3% vs aim 10%). **493** was first accepted with gold = clear, then swapped (Robin) to attempt a5: seed `ddp-eu-L493-cleanHand-a5c27`, clean + score >= 10, clear 13.2%, gold 6.8%, in band.
**Backup for 496** (`worldtour-levels/europe-level-backups.json`): if 496 proves too hard in play, swap in the avoid-Queen level seed `ddp-eu-L496-avoidQueen-a4c36`, pass right, gold bar score >= 8, measured clear 17.2%, gold 6.4% (250 games). Other avoid-Queen candidates on the same slot are in `results/L496.a1`, `a2` (clear 22-24%).
Weak golds still in the data: gold 0% in the 250-game check on 425, 457, 464, 474, 482; gold within a point of clear on 446, 471, 462 (493 is fixed).

Known caveats:
- Boss calibration uses a Monte Carlo "champion hunter" bot as the stand-in for a skilled player; real players may clear more or less. Margins range 5-126 points over 8 hands and are only comparable within a boss.
- Score/mission levels were measured against the normal AI at seat 0 (no hunting).
- Reused levels keep their original measured rates (250 trials; one from a 120-trial archive).
- Champion seat rotation and the mission rotation (`MISSIONS[(country*2 + (table===6?1:0)) % 3]`) are my assumptions, not yet confirmed by Robin.

## 6. Levels 501-600 generated (2026-11-01)
Second block, built with the same rules and tools as Europe (section 5) using `BASE=500` (`BASE=500 node run.js 10 1 100`, `retry.js`, `assemble.js`; reuse via `reuse.js`, which skips every seed already shipped). Data: `worldtour-levels/levels-501-600.json` (+ `.csv`), raw attempts `worldtour-levels/results_b500/`, readable list `worldtour-levels-501-600-list.md`. Result: 98/100 in band, mean clear 11.9% (aim 12.0%), mean gold 3.4%. Accepted misses: 510 (boss, 19% vs 14%) and 596 (avoid Q♠, 6% on the band edge). **Rule (Robin): the new block must use no hand already used in any earlier level.** `worldtour-levels/check_hands.py <resultsdir>` enforces it (known hands = europe-levels.json plus every `parseHand` string in server.js); run it before assembling any new block. Result for 501-600: 279 hands, 0 problems. Not wired into the game; continent and country names not chosen.

## 7. Levels 601-700 generated (2026-11-02)
Third block, same rules and tools (`BASE=600 node run.js 10 1 100`, then `BASE=600 MAX_ATTEMPTS=8 node retry.js <ids>`, `check_hands.py results_b600`, `BASE=600 node assemble.js`). Data: `worldtour-levels/levels-601-700.json` (+ `.csv`), raw attempts `worldtour-levels/results_b600/`, readable list `worldtour-levels-601-700-list.md`. Result: 96/100 in band, mean clear 11.8%, mean gold 5.2% (after the gold re-aim below). `check_hands.py`: 309 hands, 0 problems. Out of band after 8 attempts (accepted unless Robin says otherwise): 606 (avoid Q♠, 22.8% vs aim 14.7%), 616 (clean hand, 20% vs 14.1%), 641 (score, 8% vs 12.5%), 696 (avoid Q♠, 29.2% vs 10%). **Gold bars (Robin, 2026-11-02):** 37 non-boss levels with gold under 2% were re-sampled on 300 games (`gold_lower.js`, `LEVELS=levels-601-700.json`) and each now takes the bar whose gold rate is nearest 5% among bars that reach >= 2% (never below the clear bar); 613 is fixed at win 8+ tricks. The other levels were kept as they were on request. Gold equals clear: 626 633 647 663 695 698 (the first/last two because no bar above clear reaches 2%, 633/663/698 as generated). Bosses: 610 (0% gold in 100 games), 690, 700 are under 2%. Not wired into the game.

## 8. Levels 701-800 generated (2026-11-03)
Fourth block, same rules and tools (`BASE=700 node run.js 10 1 100`, then `BASE=700 MAX_ATTEMPTS=8 node retry.js <ids>`, `check_hands.py results_b700`, `BASE=700 node assemble.js`). Data: `worldtour-levels/levels-701-800.json` (+ `.csv`), raw attempts `worldtour-levels/results_b700/`, readable list `worldtour-levels-701-800-list.md`. Result: 96/100 in band (743 deliberately easier, see below), mean clear 11.7%, mean gold 5.4% after the gold re-aim of 2026-11-03. `check_hands.py`: 265 hands, 0 problems. Out of band after 8 attempts (all three accepted by Robin, 2026-11-03): 706 (avoid Q♠, 9.6% vs aim 14.7%), 753 (avoid Q♠, 6.8% vs 11.7%), 796 (avoid Q♠, 18.4% vs 10%): the clear rate of an avoid-Q♠ level is fixed by the hand. Gold (Robin, 2026-11-03): the 32 non-boss levels with gold under 2% were re-aimed at ~5% (same method as 601-700); only bosses 730 740 760 790 are still under 2%; gold equals clear on 716 731 776 791 793.

## 9. Levels 801-900 generated (2026-11-03)
Fifth block, same rules and tools (`BASE=800 node run.js 10 1 100`, then `BASE=800 MAX_ATTEMPTS=8 node retry.js <ids>`, `check_hands.py results_b800`, `BASE=800 node assemble.js`). Data: `worldtour-levels/levels-801-900.json` (+ `.csv`), raw attempts `worldtour-levels/results_b800/`, readable list `worldtour-levels-801-900-list.md`. Result: 100/100 in band (89 after the first pass, the 11 misses all came in on re-roll), mean clear 11.7%, mean gold 4.9% after the gold re-aim of 2026-11-03. `check_hands.py`: 296 hands, 0 problems against every earlier level including 701-800. Gold (Robin, 2026-11-03): the 27 non-boss levels with gold under 2% were re-aimed at ~5%; only boss 830 is still under 2%; gold equals clear on 805 863 893.

- 2026-11-03 (Robin): on 764 768 (701-800) and 842 878 881 (801-900) the gold line was raised one point above the clear line (gold now 0.7-2%). 743 instead: clear = win >= 11 tricks, gold = win >= 12 tricks (Robin, 2026-11-03).

## 10. Levels 901-1000 generated (2026-11-03)
Sixth block, same rules and tools (`BASE=900 node run.js 10 1 100`, then `BASE=900 MAX_ATTEMPTS=8 node retry.js <ids>`, `check_hands.py results_b900`, `BASE=900 node assemble.js`). Data: `worldtour-levels/levels-901-1000.json` (+ `.csv`), raw attempts `worldtour-levels/results_b900/`, readable list `worldtour-levels-901-1000-list.md`. Result: 98/100 in band (89 after the first pass; 9 of the 11 misses came in on re-roll), mean clear 12.2%, mean gold 5.2% after the gold re-aim of 2026-11-03. `check_hands.py`: 309 hands, 0 problems against every earlier level including 801-900. Out of band after 8 attempts (accepted by Robin, 2026-11-03): 936 (avoid Q♠, 26% vs aim 12.8%), 953 (avoid Q♠, 3% vs 11.7%). Gold (Robin, 2026-11-03): the 32 non-boss levels with gold under 2% were re-aimed at ~5%; 956 then raised one point above clear (win >= 3 tricks); only bosses 940 and 1000 are still under 2%; gold equals clear on 933 946 963 993.

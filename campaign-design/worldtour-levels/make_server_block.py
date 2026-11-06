"""europe-levels.json -> the World Tour block inside server.js (between the WT-LEVELS markers).

Run from anywhere:  python -I -X utf8 make_server_block.py
The first run inserts the markers just before `const CAMPAIGN_LEVEL_LIST`; later runs replace what is between them.
Regenerate after any change to europe-levels.json (the client only reads ids, objectives and the pass direction).
server.js uses CRLF line endings; this keeps whatever the file already has.
"""
import io, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SERVER = os.path.join(ROOT, 'server.js')
DATA = [os.path.join(HERE, 'europe-levels.json'), os.path.join(HERE, 'levels-501-600.json'), os.path.join(HERE, 'levels-601-700.json'), os.path.join(HERE, 'levels-701-800.json')]   # Europe 401-500, Asia 501-600, Africa 601-700, South America 701-800
BEGIN = '// WT-LEVELS-BEGIN'
END = '// WT-LEVELS-END'
NL, CRLF = chr(10), chr(13) + chr(10)

# cc, adjective, city, the Great Eight member who leads the country, the second member beside the player at the Keeper's Table
COUNTRIES = [
    ('IT', 'Italian', 'Rome', 'the_closer', 'the_sharp'),
    ('ES', 'Spanish', 'Madrid', 'the_optimist', 'the_closer'),
    ('PT', 'Portuguese', 'Porto', 'the_sharp', 'the_closer'),
    ('NL', 'Dutch', 'Rotterdam', 'the_charmer', 'the_closer'),
    ('GB', 'British', 'London', 'the_closer', 'the_charmer'),       # London's lead is the Player: two members sit in
    ('BE', 'Belgian', 'Brussels', 'the_wildcard', 'the_closer'),
    ('DE', 'German', 'Berlin', 'the_scholar', 'the_closer'),
    ('PL', 'Polish', 'Warsaw', 'the_jester', 'the_closer'),
    ('DK', 'Danish', 'Copenhagen', 'the_sharp', 'the_scholar'),     # group chapters: two of the group
    ('FR', 'French', 'Paris', 'the_closer', 'the_wildcard'),
    # ASIA (tables 501-600). Lead = the Great Eight member the script focuses on in that country; mate = my choice for the second member at the Keeper's
    # Table (the script says "selected members of the Eight"). Jakarta (PLAYER), Taipei (full group) and Shanghai (PLAYER / SCHOLAR / GROUP) have no single lead.
    ('SAU', 'Saudi', 'Riyadh', 'the_closer', 'the_sharp'),
    ('IND', 'Indian', 'Mumbai', 'the_optimist', 'the_closer'),
    ('THA', 'Thai', 'Bangkok', 'the_charmer', 'the_closer'),
    ('VNM', 'Vietnamese', 'Ho Chi Minh City', 'the_wildcard', 'the_closer'),
    ('PHL', 'Filipino', 'Manila', 'the_jester', 'the_closer'),
    ('IDN', 'Indonesian', 'Jakarta', 'the_closer', 'the_charmer'),
    ('TWN', 'Taiwanese', 'Taipei', 'the_sharp', 'the_scholar'),
    ('CHN', 'Chinese', 'Shanghai', 'the_scholar', 'the_closer'),
    ('KOR', 'Korean', 'Seoul', 'the_scholar', 'the_closer'),
    ('JPN', 'Japanese', 'Tokyo', 'the_sharp', 'the_closer'),
    # AFRICA (tables 601-700), lead from the script's spotlight plan: Cairo Scholar, Tunis Closer, Marrakech Charmer, Accra Optimist, Kampala Wildcard,
    # Nairobi Jester, Dar es Salaam Sharp. Algiers is the full group, Lagos is the PLAYER's chapter and Cape Town the whole Great Eight, so those three take
    # two members of my choosing (the second member everywhere is my pick; the script says "selected members of the Eight").
    ('EGY', 'Egyptian', 'Cairo', 'the_scholar', 'the_closer'),
    ('TUN', 'Tunisian', 'Tunis', 'the_closer', 'the_sharp'),
    ('MAR', 'Moroccan', 'Marrakech', 'the_charmer', 'the_closer'),
    ('DZA', 'Algerian', 'Algiers', 'the_sharp', 'the_scholar'),
    ('GHA', 'Ghanaian', 'Accra', 'the_optimist', 'the_closer'),
    ('NGA', 'Nigerian', 'Lagos', 'the_closer', 'the_charmer'),
    ('UGA', 'Ugandan', 'Kampala', 'the_wildcard', 'the_closer'),
    ('KEN', 'Kenyan', 'Nairobi', 'the_jester', 'the_closer'),
    ('TZA', 'Tanzanian', 'Dar es Salaam', 'the_sharp', 'the_closer'),
    ('ZAF', 'South African', 'Cape Town', 'the_jester', 'the_sharp'),
    # SOUTH AMERICA (tables 701-800), lead from the script's spotlight plan: Paramaribo Wildcard, Bogota Optimist, Quito Sharp (runs with Closer), Buenos Aires Charmer,
    # Montevideo Scholar, Asuncion Closer (Jester is horrified he learned Spanish). Caracas and Lima are the full group, Santiago is the PLAYER's chapter and Rio is
    # Jester's finale, but Jester MISSES the final Keeper's Table ("one chair is empty"), so Rio takes Closer + Sharp. The second member everywhere is my pick.
    ('SUR', 'Surinamese', 'Paramaribo', 'the_wildcard', 'the_closer'),
    ('VEN', 'Venezuelan', 'Caracas', 'the_sharp', 'the_closer'),
    ('COL', 'Colombian', 'Bogota', 'the_optimist', 'the_closer'),
    ('ECU', 'Ecuadorian', 'Quito', 'the_sharp', 'the_closer'),
    ('PER', 'Peruvian', 'Lima', 'the_optimist', 'the_closer'),
    ('CHL', 'Chilean', 'Santiago', 'the_closer', 'the_charmer'),
    ('ARG', 'Argentine', 'Buenos Aires', 'the_charmer', 'the_closer'),
    ('URY', 'Uruguayan', 'Montevideo', 'the_scholar', 'the_closer'),
    ('PRY', 'Paraguayan', 'Asuncion', 'the_closer', 'the_jester'),
    ('BRA', 'Brazilian', 'Rio de Janeiro', 'the_closer', 'the_sharp'),
]

HEAD = """// WORLD TOUR: EUROPE (tables 401-500), ASIA (501-600), AFRICA (601-700) and SOUTH AMERICA (701-800)
// GENERATED by campaign-design/worldtour-levels/make_server_block.py from europe-levels.json + levels-501-600.json + levels-601-700.json + levels-701-800.json: do not edit by hand.
// Forty countries x ten tables. Tables 1-9 are single fixed hands against three local players; table 10 (the Keeper's Table)
// is an 8-hand 'beatChampion' fight (L/R/A/K twice) against the country champion with two Great Eight members beside the
// player. They live in CAMPAIGN_LEVELS like every other level (so start / result / unlock / credits are the existing code),
// but in their own chapters (WT_CHAPTERS, ids 41-80, NOT in CAMPAIGN_CHAPTERS: the Hundred Tables map and the shop's
// chapter rewards must not see them) and `worldTour: true` keeps them out of the Hundred Tables map payload.
const WT_COUNTRIES = [
@COUNTRIES@
];
const WT_EUROPE_DATA = [
@DATA@
];
// Countries that have their own local portraits (public/campaign/worldtour/locals/<cc>/<nn>.webp, made by worldtour-art/make_local.py): 26 different
// locals (wt_local_<cc>_01..26) fill tables 1-9 in order, and a 27th (wt_local_<cc>_27) wears the CHAMPION's picture but is still just "<Adjective> Player":
// the champion-to-be, sitting at one seat of tables 1-9 that is picked once per country (seeded, so it is the same seat every time and after a restart).
// Countries not listed keep the single generic wt_local_<cc> for all 27 seats.
const WT_LOCALS = { IT: 26, ES: 26, NL: 26, BE: 26, DE: 26, DK: 26 };
function wtLocalTables(cc, lc, n) {
  const total = 27;                                     // 9 tables x 3 seats = n locals + the champion-to-be
  let h = 7; for (const ch of cc) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  for (let r = 0; r < 3; r++) h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
  const cslot = (h >>> 8) % total;
  const slots = []; let next = 1;
  for (let k = 0; k < total; k++) {
    const num = k === cslot ? n + 1 : next++;
    slots.push('wt_local_' + lc + '_' + String(num).padStart(2, '0'));
  }
  const tables = [];
  for (let t = 0; t < 9; t++) tables.push(slots.slice(t * 3, t * 3 + 3));
  return tables;
}
const WT_CHAPTERS = [];
WT_COUNTRIES.forEach(([cc, adj, city, lead, mate], i) => {
  const lc = cc.toLowerCase();
  WT_CHAPTERS.push({ id: 41 + i, title: city, levelStart: 401 + i * 10, levelEnd: 410 + i * 10, slug: 'wt_' + lc, bossId: 'wt_champion_' + lc });
  CAMPAIGN_CHARACTERS['wt_champion_' + lc] = { id: 'wt_champion_' + lc, name: adj + ' Champion' };
  CAMPAIGN_CHARACTERS['wt_local_' + lc] = { id: 'wt_local_' + lc, name: adj + ' Player' };
  const nLoc = WT_LOCALS[cc] || 0;
  const locTables = nLoc ? wtLocalTables(cc, lc, nLoc) : null;
  for (let k = 1; k <= (nLoc ? nLoc + 1 : 0); k++) {
    const lid = 'wt_local_' + lc + '_' + String(k).padStart(2, '0');
    CAMPAIGN_CHARACTERS[lid] = { id: lid, name: adj + ' Player' };
  }
  const bossRow = WT_EUROPE_DATA.find(d => d.id === 410 + i * 10);
  const cseat = bossRow.o.championSeat;                       // player-seat number 1-3; the roster array is seats 1-3 as indexes 0-2
  // Tables 1-9: three local players. Table 10: the lead and the second Great Eight member in the two seats the champion does not
  // take (the champion's own seat is filled by the usual boss substitution at bossSeat).
  CAMPAIGN_CHAPTER_ROSTER[41 + i] = {
    regulars: (levelId) => {
      if (levelId % 10 !== 0) return locTables ? locTables[(levelId % 10) - 1].slice() : ['wt_local_' + lc, 'wt_local_' + lc, 'wt_local_' + lc];
      const ids = [null, null, null];
      ids[cseat - 1] = 'wt_champion_' + lc;
      const others = [lead, mate];
      for (let s = 0; s < 3; s++) if (ids[s] == null) ids[s] = others.shift();
      return ids;
    },
    bossSeat: cseat - 1,
  };
});
WT_EUROPE_DATA.forEach(d => {
  const i = Math.floor((d.id - 401) / 10), lc = WT_COUNTRIES[i][0].toLowerCase(), boss = d.k === 'boss';
  CAMPAIGN_LEVELS[d.id] = Object.assign({
    id: d.id, chapter: 41 + i, type: boss ? 'BOSS' : 'Normal', forcePassDir: d.p || null, hands: boss ? 8 : 1,
    seed: d.s, objective: d.o, worldTour: true,
  }, boss ? { hands8: d.hl.map(parseHand), bossId: 'wt_champion_' + lc, bossTitle: 'Champion' } : { hand: parseHand(d.h) });
});
"""


def level_rows():
    lv = []
    for f in DATA: lv += json.load(io.open(f, encoding='utf-8'))
    rows = []
    for l in lv:
        r = {'id': l['id'], 'k': l['kind'], 's': l['seed'], 'o': l['objective']}
        if l.get('forcePassDir'): r['p'] = l['forcePassDir']
        if l['kind'] == 'boss': r['hl'] = l['handList']
        else: r['h'] = l['hand']
        rows.append(r)
    return rows


def block():
    data = (',' + NL).join('  ' + json.dumps(r, ensure_ascii=False, separators=(',', ':')) for r in level_rows())
    cs = (',' + NL).join("  ['%s', '%s', '%s', '%s', '%s']" % c for c in COUNTRIES)
    return BEGIN + NL + HEAD.replace('@COUNTRIES@', cs).replace('@DATA@', data) + END + NL


def main():
    src = io.open(SERVER, encoding='utf-8', newline='').read()   # keep the file's own line endings
    crlf = CRLF in src
    b = block()
    if crlf: b = b.replace(NL, CRLF)
    if BEGIN in src:
        i = src.index(BEGIN)
        j = src.index(END, i) + len(END)
        j += len(CRLF) if src[j:j + 2] == CRLF else (1 if src[j:j + 1] == NL else 0)
        src = src[:i] + b + src[j:]
    else:
        anchor = 'const CAMPAIGN_LEVEL_LIST = '
        assert src.count(anchor) == 1
        src = src.replace(anchor, b + anchor)
    io.open(SERVER, 'w', encoding='utf-8', newline='').write(src)
    print('server.js updated,', len(b), 'chars')


if __name__ == '__main__':
    main()

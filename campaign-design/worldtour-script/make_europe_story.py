"""script_cues.json -> public/campaign/worldtour/europe-story.json (what the real app loads) + a review dump.

Run:  python -I -X utf8 make_europe_story.py            # writes the json
      python -I -X utf8 make_europe_story.py --review IT  # prints a country as 'idx|SPEAKER|mood|text' to check the moods by eye

Cue shapes in the output (compact, the game reads them):
  ["s", SPEAKER, text, mood]   a spoken line; mood is neutral | smile | surprised | serious (used by the member portraits)
  ["u", text]                  ON-SCREEN TEXT (the game decides whether it is a banner or a progress UI line)
  ["h", text]                  scene header
  ["loc", n, title]            location change: 1 = first public place, 2 = second, 3 = the Keeper's Table venue
["b", text]                  narration card (a few scene-setting 'v' lines, see SHOW_V)
Dropped on purpose: the other ["v"] visual/action direction (never shown) and ["sys"] implementation notes. The 'v' line right before a
spoken line is still read here, to help pick the mood ("smiles", "stops", ...).

Moods are set BY HAND in mood_overrides.json, one string per block listing only the non-neutral lines:
  {"IT.open": "0u 1u 5m 11s", "ES.12": "0s"}     idx = position among that block's SPOKEN lines (see --review), letter m=smile u=surprised s=serious n=neutral
Every line not listed is neutral. A block with NO entry falls back to `heuristic()` (rough rules) and is reported when building.
Block ids: <CC>.open, <CC>.<n> (the dialogue after table n), <CC>.handoff, world.return, world.preview.<NAME>, world.commit.
"""
import io, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SRC = os.path.join(HERE, 'script_cues.json')
OVR = os.path.join(HERE, 'mood_overrides.json')
OUT = os.path.join(ROOT, 'public', 'campaign', 'worldtour', 'europe-story.json')
MOODS = ('neutral', 'smile', 'surprised', 'serious')

SMILE_W = re.compile(r"\b(good|great|wonderful|beautiful|perfect|love|loved|thank|thanks|welcome|lovely|delighted|excellent|brilliant|nice|fun|happy|cheers|congratulations|well done|proud|haha|ha|funny|fantastic|amazing|glad|enjoy)\b", re.I)
SERIOUS_W = re.compile(r"\b(problem|risk|danger|dangerous|careful|rules?|must|cannot|can't|won't|never|lose|lost|wrong|concern|concerned|serious|warning|trouble|worried|worry|unacceptable|mistake|responsib\w+|pressure|failure|fail)\b", re.I)
SURPRISE_START = re.compile(r"^(what|wait|wow|really|seriously|how|you did|no way|excuse me|sorry|hold on|oh)\b", re.I)
V_SMILE = re.compile(r"\b(smil\w+|grin\w*|laugh\w*|chuckl\w+|amused|delighted|beam\w*)\b", re.I)
V_SURPRISE = re.compile(r"\b(stops|freez\w+|stunn\w+|gasp\w*|stare\w*|silence|everyone stops|shock\w*|astonish\w*|looks? at .* (in disbelief|stunned))\b", re.I)
V_SERIOUS = re.compile(r"\b(quiet\w*|serious\w*|grave\w*|cold\w*|firm\w*|stern\w*|tense\w*|sits? (up|straight)|nods slowly)\b", re.I)


def heuristic(text, prev_v=''):
    t = text.strip()
    if '?!' in t or '!?' in t: return 'surprised'
    if SURPRISE_START.search(t) and t.endswith('?'): return 'surprised'
    if prev_v and V_SURPRISE.search(prev_v): return 'surprised'
    if prev_v and V_SMILE.search(prev_v): return 'smile'
    if SMILE_W.search(t) and not t.endswith('?'): return 'smile'
    if SERIOUS_W.search(t): return 'serious'
    if prev_v and V_SERIOUS.search(prev_v): return 'serious'
    if re.match(r'^(no|stop|enough|careful)\b', t, re.I) and len(t) < 30: return 'serious'
    return 'neutral'


def blocks(d):
    """(block id, cue list) for everything in the JSON, in script order."""
    for cc in ['IT', 'ES', 'PT', 'NL', 'GB', 'BE', 'DE', 'PL', 'DK', 'FR']:
        c = d.get(cc)
        if not c: continue
        yield cc + '.open', c['open']
        for n in sorted(c['after'], key=int): yield '%s.%s' % (cc, n), c['after'][n]
        if c.get('handoff'): yield cc + '.handoff', c['handoff']
    w = d.get('world')
    if w:
        yield 'world.return', w['return']
        for k, v in w['previews'].items(): yield 'world.preview.' + k, v
        # the script's "Short revisit callback" (a SYSTEM note inside each preview): played on the SECOND tap of an unplayed continent
        for k, v in w['previews'].items():
            for c in v:
                if c[0] == 'sys' and c[1].startswith('Short revisit callback'):
                    yield 'world.revisit.' + k, [['s', sp, tx] for sp, tx in re.findall(r'([A-Z]+): “([^”]*)”', c[1])]
        yield 'world.commit', w['commit']


LETTER = {'n': 'neutral', 'm': 'smile', 'u': 'surprised', 's': 'serious'}


def parse_moods(spec, n):
    """'0u 3m' -> list of n moods (neutral elsewhere)."""
    moods = ['neutral'] * n
    for tok in spec.split():
        i, l = int(tok[:-1]), tok[-1]
        if not (0 <= i < n) or l not in LETTER: raise SystemExit('bad mood token %r (block has %d spoken lines)' % (tok, n))
        moods[i] = LETTER[l]
    return moods


# Scene-setting lines of the script that are normally NOT shown (VISUAL / ACTION text) but that the player needs to follow the next lines:
# {block id: [prefixes of the 'v' lines to show as a narration card]}. The names are written in plain case ("Closer", not "CLOSER").
SHOW_V = {
    'IT.open': ['Rome. Warm evening.'],   # the local man who asks CLOSER something in Italian, which the Jester's "No." reacts to
}


def convert(bid, cues, spec):
    n_sp = sum(1 for c in cues if c[0] == 's')
    ovr = parse_moods(spec, n_sp) if spec is not None else None
    out, prev_v, si = [], '', 0
    for c in cues:
        k = c[0]
        if k == 'v':
            prev_v = c[1]
            if any(c[1].startswith(pre) for pre in SHOW_V.get(bid, [])):
                out.append(['b', c[1].replace('CLOSER', 'Closer')])
            continue
        if k == 'sys': continue
        if k == 's':
            mood = ovr[si] if ovr is not None else heuristic(c[2], prev_v)
            if mood not in MOODS: raise SystemExit('bad mood %r in %s[%d]' % (mood, bid, si))
            out.append(['s', c[1], c[2], mood]); si += 1; prev_v = ''
        elif k in ('u', 'h'): out.append([k, c[1]])
        elif k == 'loc': out.append(['loc', c[1], c[2]])
    return out


def build():
    d = json.load(io.open(SRC, encoding='utf-8'))
    ovr = json.load(io.open(OVR, encoding='utf-8')) if os.path.exists(OVR) else {}
    story = {}; missing = []
    for bid, cues in blocks(d):
        parts = bid.split('.', 1)
        conv = convert(bid, cues, ovr.get(bid))
        if ovr.get(bid) is None: missing.append(bid)
        if parts[0] == 'world': story.setdefault('world', {})[parts[1]] = conv
        else:
            cc, rest = parts
            e = story.setdefault(cc, {'after': {}})
            if rest == 'open': e['open'] = conv
            elif rest == 'handoff': e['handoff'] = conv
            else: e['after'][rest] = conv
    build.missing = missing
    return story


def main():
    if len(sys.argv) > 2 and sys.argv[1] == '--review':
        d = json.load(io.open(SRC, encoding='utf-8'))
        ovr = json.load(io.open(OVR, encoding='utf-8')) if os.path.exists(OVR) else {}
        want = sys.argv[2]
        for bid, cues in blocks(d):
            if not (bid == want or bid.startswith(want + '.')): continue
            conv = convert(bid, cues, ovr.get(bid))
            print('## ' + bid)
            si = 0; pv = ''
            vi = [c for c in cues if c[0] in ('v', 's')]
            # print visual cues (shortened) in context so the mood can be judged
            for c in vi:
                if c[0] == 'v': print('   [v] ' + c[1][:110])
                else:
                    cc = [x for x in conv if x[0] == 's'][si]
                    print('%d|%s|%s|%s' % (si, c[1][:9], cc[3][:3], c[2][:140])); si += 1
        return
    story = build()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    io.open(OUT, 'w', encoding='utf-8', newline='\n').write(json.dumps(story, ensure_ascii=False, separators=(',', ':')))
    n = sum(1 for b in json.dumps(story).split('["s"') ) - 1
    if build.missing: print('blocks still on the rough heuristic (%d):' % len(build.missing), ' '.join(build.missing))
    print('wrote', OUT, os.path.getsize(OUT), 'bytes,', n, 'spoken lines')


if __name__ == '__main__':
    main()

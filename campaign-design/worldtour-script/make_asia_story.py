"""Great_Eight_World_Tour_Asia_Levels_1-100_Movie_Script_BRANCH_SAFE.docx -> public/campaign/worldtour/asia-story.json

The docx is styled (Script Character / Script Dialogue / Script Action / On Screen / Gameplay / Heading 1-2), so this reads the styles directly.
Output (merged into the story the client already loads, europe-story.json, by wtLoadStory):
  {"SAU": {"open": [cues], "after": {"1": [cues], ... "10": [cues]}, "handoff": [cues]}, "IND": {...}, ..., "JPN": {...},
   "world": {"revisit.ASIA": [cues], "commit.ASIA": [cues], "callbacks.ASIA": {"PLAYER": [{"topic":..,"trigger":..,"cues":[..]}], ...}}}
Country codes are ISO alpha-3 (SAU IND THA VNM PHL IDN TWN CHN KOR JPN) so they never collide with the continent keys (SA = South America ...).
"after" is keyed by the CONTINENT-WIDE table number 1-100 (Riyadh 1-10 ... Tokyo 91-100), like Europe.

Cues, as in europe-story.json: ["s", SPEAKER, text, mood] spoken, ["u", text] on-screen text, ["b", text] story box, ["loc", n, title] location (1/2 public, 3 = Keeper's Table).
NEW: ["if", cond, [cues]] a conditional section; cond "euas" = "Asia is the SECOND continent played (EUROPE -> ASIA)", "!euas" = Asia is third or later.
The client flattens it (wtBlockToCues / wtCondOk). Callback sections ("IF NARRATIVE - EUROPE -> ASIA CALLBACK") become ["if","euas",[...]].
Stage directions (Script Action) ARE shown as story-box cards (the script's legend says not to; the owner decided otherwise, 2026-11-03), cleaned by scene_lines.py. Moods: the same keyword heuristic as europe-story.json (not hand-set).
"""
import io, json, os, re, sys
import docx

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SRC = os.path.join(ROOT, 'afbeeldingen', 'World Tour', 'Asia', 'Great_Eight_World_Tour_Asia_Levels_1-100_Movie_Script_BRANCH_SAFE.docx')
OUT = os.path.join(ROOT, 'public', 'campaign', 'worldtour', 'asia-story.json')
sys.path.insert(0, HERE)
from make_europe_story import heuristic   # the same mood heuristic
import scene_lines                         # scene / action lines shown as narration cards (same cleaning as Europe)

CODES = ['SAU', 'IND', 'THA', 'VNM', 'PHL', 'IDN', 'TWN', 'CHN', 'KOR', 'JPN']
STY = {'Script Character': 'C', 'Script Dialogue': 'D', 'Script Action': 'V', 'On Screen': 'U', 'Gameplay': 'G', 'Heading 1': 'H1', 'Heading 2': 'H2', 'Story Box': 'B'}


def parse():
    P = docx.Document(SRC).paragraphs
    out = {c: {'open': [], 'after': {}, 'handoff': []} for c in CODES}
    world = {}
    callbacks = {}
    cur = None            # country code
    block = None          # the list currently being filled
    stack = []            # conditional sections: [(cond, list)]
    pending = None
    prev_v = ''
    mode = 'pre'          # pre (entry + flight), chapter, finale, appendix
    entry = {'A': [], 'B': []}
    cb_cur = None

    def put(c):
        (stack[-1][1] if stack else block).append(c)

    i = 0
    for idx, p in enumerate(P):
        s = STY.get(p.style.name, 'N')
        t = p.text.strip()
        if not t and s not in ('H1', 'H2'): continue
        if s == 'H1':
            stack.clear(); pending = None
            m = re.match(r'CHAPTER (\d+) ', t)
            if t.startswith('ASIA ENTRY'): mode = 'entry'; block = entry['A']; continue
            if m:
                cur = CODES[int(m.group(1)) - 1]; mode = 'chapter'
                # the intercontinental flight (before chapter 1) leads into Riyadh's opening
                block = out[cur]['open']
                if cur == 'SAU' and 'flight' in world: block.extend(world.pop('flight'))
                continue
            if t.startswith('IMPLEMENTATION APPENDIX'): mode = 'appendix'; block = None; continue
            continue
        if s == 'H2':
            stack.clear(); pending = None
            if mode == 'entry':
                if t.startswith('INTERCONTINENTAL FLIGHT'):
                    mode = 'flight'; block = world.setdefault('flight', [])
                    stack.append(('euas', []))     # the "IF NARRATIVE - ASIA IS THE SECOND CONTINENT" line sits just above this heading and was cleared with the stack
                continue
            if mode == 'flight': continue
            if mode == 'appendix':
                cb_cur = {'topic': t, 'trigger': '', 'cues': []}
                callbacks.setdefault(t.split(' — ')[0].strip().upper(), []).append(cb_cur)
                block = cb_cur['cues']; continue
            if mode != 'chapter': continue
            m = re.match(r'AFTER LEVEL (\d+)', t)
            if m: block = out[cur]['after'].setdefault(m.group(1), []); continue
            if re.match(r'LEVEL \d+', t): continue          # the gameplay marker: the block ends here
            if t.startswith('ASIA FINALE') or t.startswith('RETURN TO WORLD MAP'):
                block = out[cur]['handoff']; continue
            m = re.match(r'LOCATION ([AB])\b', t)
            if m: block.append(['loc', 1 if m.group(1) == 'A' else 2, t]); continue
            if 'KEEPER' in t and 'TABLE' in t: block.append(['loc', 3, t]); continue
            continue                                           # ARRIVAL / FLIGHT TO ...: part of the opening block
        if block is None: continue
        if s == 'G':
            if t.startswith('IF NARRATIVE'):
                stack.append(('euas', [])); continue
            if t.startswith('ELSE'):
                stack.append(('!euas', [])); continue
            if t.startswith('END IF') or t.startswith('END ELSE'):
                if stack:
                    cond, cues = stack.pop()
                    if cues: put(['if', cond, cues])
                continue
            continue                                           # GAMEPLAY / CALLBACK SLOT / rules: not shown
        if s == 'C':
            pending = t; continue
        if s == 'D':
            sp = pending or 'NARRATOR'; pending = None
            put(['s', sp, t, heuristic(t, prev_v)]); prev_v = ''; continue
        if s == 'U':
            put(['u', t.split(':', 1)[1].strip() if t.startswith('ON-SCREEN TEXT:') else t]); continue
        if s == 'B':
            put(['b', t.split(':', 1)[1].strip() if t.startswith('STORY BOX:') else t]); continue
        if s == 'V':
            prev_v = t
            if mode == 'entry' and t.startswith('PLAYER confirms START ASIA'):
                block = entry['B']
            if mode == 'appendix' and cb_cur is not None and t.startswith('Preferred trigger'):
                cb_cur['trigger'] = t.split(':', 1)[1].strip()
            # Scene / action lines are shown as narration cards (owner, 2026-11-03), except in the callback appendix (implementation notes).
            card = scene_lines.clean(t) if mode in ('chapter', 'entry', 'flight') else None
            if card: put(['b', card])
            continue
    # the entry scene: A = before START (played on the 2nd tap of Asia, the script's "You came back"), B = after START (the commit scene)
    world['revisit.ASIA'] = entry['A']
    world['commit.ASIA'] = entry['B']
    world['callbacks.ASIA'] = callbacks
    for k in ('flight',): world.pop(k, None)
    out['world'] = world
    return out


def count(o):
    n = 0
    for c in o:
        if c[0] == 's': n += 1
        elif c[0] == 'if': n += count(c[2])
    return n


def main():
    story = parse()
    io.open(OUT, 'w', encoding='utf-8', newline='\n').write(json.dumps(story, ensure_ascii=False, separators=(',', ':')))
    tot = 0
    for c in CODES:
        e = story[c]
        n = count(e['open']) + sum(count(v) for v in e['after'].values()) + count(e['handoff'])
        tot += n
        print(c, 'open', count(e['open']), 'after', sorted(map(int, e['after']))[:1], '..', sorted(map(int, e['after']))[-1:], 'handoff', count(e['handoff']), 'lines', n)
    w = story['world']
    print('revisit.ASIA', count(w['revisit.ASIA']), 'commit.ASIA', count(w['commit.ASIA']), 'callbacks', {k: len(v) for k, v in w['callbacks.ASIA'].items()})
    print('spoken lines in countries:', tot, ' file bytes:', os.path.getsize(OUT))


if __name__ == '__main__':
    main()

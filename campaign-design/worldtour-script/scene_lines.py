"""Scene / action lines ("Script Action" in the docx, 'v' in script_cues.json) as narration cards, for every continent.

The script's own legend says stage directions are not shown; the owner decided otherwise (2026-11-03: "I want the scene lines written
in everywhere"). They are shown as ["b", text] cards, in script order, between the spoken lines. A few things inside them are not for
the player and are removed here (one place, so Europe, Asia and Africa stay identical):
  - a leading gameplay sentence: "PLAYER clears Level 29." / "PLAYER confirms START ASIA ..."
  - design commentary that slipped into an action line ("the chapter belongs to the group", "deliberately not a named real-world
    venue", "five unplayed regions remain selectable")
  - lines that are pure implementation notes ("Preferred trigger: ...", "SYSTEM ...")
"""
import re

NAMES = ('CLOSER', 'OPTIMIST', 'SHARP', 'CHARMER', 'WILDCARD', 'SCHOLAR', 'JESTER', 'PLAYER')

_LEADING_GAMEPLAY = re.compile(r'^PLAYER (clears|confirms|enters|opens|starts|selects|taps)\b[^.]*\.\s*', re.I)
_DROP_WHOLE = re.compile(r'^(SYSTEM|Preferred trigger|IMPLEMENTATION|NOTE:)', re.I)
_CUT = [
    re.compile(r'\s*For the first time, the chapter belongs to the group rather than one individual\.'),
    re.compile(r'\s*Five unplayed regions remain selectable:[^.]*\.'),
    re.compile(r'\s*The room evokes classic Paris nightlife without reproducing any specific protected show\.'),   # a legal remark
    re.compile(r'\s*The screens display only pre-match public statistics and decorative visuals\.( No live hidden-hand information is shown\.)?'),   # a game-design remark
    re.compile(r'\s*(Asia|Africa|Europe|South America|North America|Oceania) is highlighted because PLAYER (has )?selected it from the continent preview\.', re.I),   # describes the app's own screen
]
_VENUE_NOTE = re.compile(r'\bIt is deliberately not a named real-world venue:\s*(\w)')


def nice(txt):
    """CLOSER -> Closer inside a narration card."""
    for n in NAMES:
        txt = txt.replace(n, n.capitalize())
    return txt


def clean(text):
    """The card text for a scene line, or None when nothing is left to show."""
    t = (text or '').strip()
    if not t or _DROP_WHOLE.search(t):
        return None
    while True:                                   # "PLAYER clears Level 19. PLAYER ..." could stack
        t2 = _LEADING_GAMEPLAY.sub('', t)
        if t2 == t:
            break
        t = t2
    for rx in _CUT:
        t = rx.sub('', t)
    t = _VENUE_NOTE.sub(lambda m: m.group(1).upper(), t)   # "... cabaret. It is deliberately not ...: deep red" -> "... cabaret. Deep red"
    t = t.strip()
    return nice(t) if t else None

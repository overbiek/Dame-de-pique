"""World Tour local players: one portrait each, inside a thin brass octagon line (rings/ring_local.png: no star, no seal lozenge, no
ornament) so an ordinary local never reads as one of the Great Eight (ornate ring + star) or a country champion (their country's gold seal).

  python make_local.py it            # every afbeeldingen/World Tour/Europe/Local portraits/<name> locals/<cc>_NN.jpg -> public/campaign/worldtour/locals/<cc>/NN.webp
  python make_local.py es 07         # one portrait
  python make_local.py --contact it  # also write processed/locals_<cc>_contact.png to check the cutouts by eye

Cutout, head size and backdrop glow are make_portrait.make, the same as the Great Eight and the champions. A warm backdrop needs the
WT_CUT_SAT env var (see make_portrait.py); the Italian and Spanish sets are neutral grey.
"""
import os, sys, math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SRC_DIR = os.path.join(ROOT, 'afbeeldingen', 'World Tour', 'Europe', 'Local portraits')
OUT_DIR = os.path.join(ROOT, 'public', 'campaign', 'worldtour', 'locals')
RING_PATH = os.path.join(HERE, 'rings', 'ring_local.png')
FOLDERS = {'it': 'italy locals', 'es': 'spain locals', 'be': 'belgium locals', 'dk': 'denmark locals', 'nl': 'netherlands locals', 'de': 'germany locals'}
OUT_PX = 384
sys.path.insert(0, HERE)
import make_portrait as mp
S = mp.S


def build_ring():
    """A single thin brass octagon line and nothing else: transparent outside, transparent window (the portrait fills the octagon)."""
    outer = mp.mask_of(mp.octagon(504))
    window = mp.mask_of(mp.octagon(488))
    ring = ImageChops.subtract(outer, window)
    brass = mp.gradient(mp.BRASS)
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0)); img.paste(brass, (0, 0), ring)
    os.makedirs(os.path.dirname(RING_PATH), exist_ok=True)
    img.save(RING_PATH)
    return RING_PATH


def one(cc, nn, ring):
    src = os.path.join(SRC_DIR, FOLDERS[cc], '%s_%s.jpg' % (cc, nn))
    dst_dir = os.path.join(OUT_DIR, cc); os.makedirs(dst_dir, exist_ok=True)
    dst = os.path.join(dst_dir, nn + '.webp')
    mp.make(src, dst, tint='#6b5a40', ring_path=ring)
    im = Image.open(dst).convert('RGBA').resize((OUT_PX, OUT_PX), Image.LANCZOS)
    im.save(dst, quality=88, method=5)
    return dst


def main():
    args = sys.argv[1:]
    contact = '--contact' in args
    args = [a for a in args if not a.startswith('--')]
    cc = args[0]
    ring = build_ring()
    nums = [args[1]] if len(args) > 1 else ['%02d' % i for i in range(1, 27)]
    done = []
    for nn in nums:
        done.append(one(cc, nn, ring)); print('wrote', done[-1])
    if contact and len(done) > 1:
        cols = 7; rows = math.ceil(len(done) / cols); t = 192
        sheet = Image.new('RGB', (cols * t, rows * t), (200, 200, 200))
        for i, p in enumerate(done):
            im = Image.open(p).convert('RGBA').resize((t, t), Image.LANCZOS)
            sheet.paste(im, ((i % cols) * t, (i // cols) * t), im)
        out = os.path.join(HERE, 'processed', 'locals_%s_contact.png' % cc)
        sheet.save(out); print('contact', out)


if __name__ == '__main__':
    main()

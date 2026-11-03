"""Country champion portrait: the champion sits inside their COUNTRY's gold seal (the octagon made for the gold levels).

  python make_champion.py it "Italian Champion.png"       # -> processed/champions/it.webp (512px RGBA)
  python make_champion.py --ring-only es                   # just write rings/champion_es.png (the seal with its enamel plate cut out)

The seal art is afbeeldingen/World Tour/Europe/Gold medaillons/<country> gold.png (gold rim on a pure black page, a flat enamel plate
in the middle). The ring is made like make_portrait.prep_ring does it: black connected to the picture border = outside (transparent),
and the enamel plate, found by colour from the centre, becomes the transparent window the portrait is placed in. Everything else
(cutout, head size, backdrop glow) is make_portrait.make, so the champions match the Great Eight's portraits.
"""
import os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SEAL_DIR = os.path.join(ROOT, 'afbeeldingen', 'World Tour', 'Europe', 'Gold medaillons')
CHAMP_DIR = os.path.join(ROOT, 'afbeeldingen', 'World Tour', 'Europe', 'champions')
OUT_DIR = os.path.join(HERE, 'processed', 'champions')
RING_DIR = os.path.join(HERE, 'rings')
SEAL_FILE = {'it': 'Italy gold.png', 'es': 'spain gold.png', 'pt': 'portugal gold.png', 'nl': 'netherlands gold.png', 'gb': 'engeland gold.png',
             'be': 'belgium gold.png', 'de': 'germany gold.png', 'pl': 'poland gold.png', 'dk': 'denmark gold.png', 'fr': 'france gold.png'}
S = 1024
MARGIN = 6   # px of transparent border round the seal (before the final 512 resize)
TOL = {'pt': 62, 'nl': 75, 'dk': 75}   # colour tolerance of the plate flood (default 38); these plates have a darker vignette the default stops short of
                                       # (Spain must stay at 38: its red plate touches a red band and leaks above ~60)
ASIA_DIR = os.path.join(ROOT, 'afbeeldingen', 'World Tour', 'Asia', 'champions')   # Asia: seal and raw portrait sit side by side
ASIA_SEAL = {'sau': 'saudi arabia gold seal.png', 'ind': 'india gold seal.png', 'tha': 'thailand gold seal.png', 'vnm': 'vietnam gold seal.png',
             'phl': 'philipines gold seal.png', 'idn': 'indonesia gold seal.png', 'twn': 'taiwan gold seal.png', 'chn': 'chna gold seal.png',
             'kor': 'korea gold seal.png', 'jpn': 'japan gold seal.png'}
ASIA_RAW = {'sau': 'saudi arabia champion.png', 'ind': 'india champion.png', 'tha': 'thailand champion.png', 'vnm': 'vietnam champion.png',
            'phl': 'manila champion.png', 'idn': 'Indonesia champion.png', 'twn': 'Taiwan champion.png', 'chn': 'china champion.png',
            'kor': 'korea champion.png', 'jpn': 'japan champion.png'}
RAW = {'it': 'Italian Champion.png', 'es': 'Spanish champion.png', 'pt': 'portugese champion.png', 'nl': 'dutch champion.png',
       'gb': 'british champion.png', 'be': 'belgian champion.png', 'de': 'German champion.png', 'pl': 'polish champion.png',
       'dk': 'denmark champion.png', 'fr': 'french champion.png'}


def build_ring(cc):
    img = Image.open(os.path.join(ASIA_DIR, ASIA_SEAL[cc]) if cc in ASIA_SEAL else os.path.join(SEAL_DIR, SEAL_FILE[cc])).convert('RGB')
    v = np.asarray(img.convert('HSV'))[..., 2]
    m = Image.fromarray(np.where(v < 34, 255, 0).astype(np.uint8), 'L').copy()
    w, h = img.size
    for xy in [(x, 0) for x in range(0, w, 32)] + [(x, h - 1) for x in range(0, w, 32)] + [(0, y) for y in range(0, h, 32)] + [(w - 1, y) for y in range(0, h, 32)]:
        if m.getpixel(xy) == 255:
            ImageDraw.floodfill(m, xy, 128)
    outside = Image.fromarray(np.where(np.asarray(m) == 128, 255, 0).astype(np.uint8), 'L').filter(ImageFilter.MaxFilter(3))
    ring = img.convert('RGBA'); ring.putalpha(ImageChops.invert(outside))
    box = ring.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
    ring = ring.crop(box)
    side = max(ring.size); sq = Image.new('RGBA', (side, side), (0, 0, 0, 0)); sq.paste(ring, ((side - ring.width) // 2, (side - ring.height) // 2))
    ring = sq.resize((S - 2 * MARGIN, S - 2 * MARGIN), Image.LANCZOS)
    full = Image.new('RGBA', (S, S), (0, 0, 0, 0)); full.paste(ring, (MARGIN, MARGIN)); ring = full

    # the enamel plate: colour-flood from the centre; the damask is only a few % lighter/darker, the gold band around it is far off
    rgb = ring.convert('RGB')
    ref = np.median(np.asarray(rgb)[S // 2 - 60:S // 2 + 60, S // 2 - 60:S // 2 + 60].reshape(-1, 3), axis=0)
    arr = np.asarray(rgb).astype(np.int16)
    alpha_ok = np.asarray(ring.getchannel('A')) > 200
    dist = np.abs(arr - ref[None, None, :]).max(axis=2)

    def flood(tol):
        cm = Image.fromarray(np.where((dist < tol) & alpha_ok, 255, 0).astype(np.uint8), 'L').copy()
        ImageDraw.floodfill(cm, (S // 2, S // 2), 128)
        return np.asarray(cm) == 128
    if cc in ASIA_SEAL:
        # Asia's thin-rim seals: widen the colour tolerance until the flooded area stops growing (the plate is full, the hairline band holds it back),
        # so a strong vignette or a bright damask does not leave bits of enamel in the portrait window.
        pm = flood(38); prev = pm.sum(); best = None
        for tol in (50, 62, 74, 86, 98, 110, 122):
            q = flood(tol); area = q.sum(); ratio = area / prev
            if os.environ.get('CHAMP_DEBUG'): print(cc, tol, int(area), round(ratio, 3))
            if best is None or ratio < best[0]:
                best = (ratio, q)
            if ratio <= 1.02:           # converged: the whole enamel plate is in, and the hairline band still holds it back
                break
            prev = area
        pm = best[1]
    else:
        pm = flood(TOL.get(cc, 38))
    # the window is convex: the hull of the flooded plate also covers the corner bits the colour flood misses (bright enamel reflections)
    from scipy.spatial import ConvexHull
    ys, xs = np.nonzero(pm)
    pts = np.stack([xs, ys], 1)
    hull = pts[ConvexHull(pts).vertices]
    plate = Image.new('L', (S, S), 0)
    ImageDraw.Draw(plate).polygon([tuple(map(int, q)) for q in hull], fill=255)
    # ...but every seal has a gold emblem (bull, Colosseum, Big Ben...) that rises INTO the plate. Inside the hull but not plate-coloured
    # = thin enamel slivers (leave them in the window) or that emblem (thick: keep it, in front of the portrait). An opening finds the
    # thick parts; a few small geodesic dilations bring back their thin tips (horns, mast, spire) without growing along the slivers.
    cand = ImageChops.multiply(plate, Image.fromarray(np.where(pm, 0, 255).astype(np.uint8), 'L'))
    if cc in ASIA_SEAL:
        # the Asian emblems are small and sit bottom-centre: keep the emblem exception to that box, anything else inside the hull is enamel
        box = Image.new('L', (S, S), 0); ImageDraw.Draw(box).rectangle([int(S * .28), int(S * .80), int(S * .72), S], fill=255)
        cand = ImageChops.multiply(cand, box)
    # (A gold-colour test for "emblem" was tried and is too strict: highlights and shadows on the metal are not saturated gold, so
    # the tops of Big Ben and the Eiffel Tower were lost. Plates whose vignette the flood misses get a wider TOL instead.)
    prot = cand.filter(ImageFilter.MinFilter(15)).filter(ImageFilter.MaxFilter(15))
    for _ in range(3):
        prot = ImageChops.multiply(prot.filter(ImageFilter.MaxFilter(21)), cand)
    plate = ImageChops.subtract(plate, prot)
    plate = plate.filter(ImageFilter.MinFilter(3))                                       # pull the edge back a hair
    a = ring.getchannel('A')
    ring.putalpha(ImageChops.multiply(a, ImageChops.invert(plate.filter(ImageFilter.GaussianBlur(0.8)))))
    return ring


def main():
    args = sys.argv[1:]
    ring_only = '--ring-only' in args
    args = [a for a in args if not a.startswith('--')]
    cc = args[0]
    ring = build_ring(cc)
    rp = os.path.join(RING_DIR, 'champion_%s.png' % cc)
    ring.save(rp)
    if ring_only:
        return
    sys.path.insert(0, HERE)
    import make_portrait as mp
    os.makedirs(OUT_DIR, exist_ok=True)
    raw = args[1] if len(args) > 1 else (ASIA_RAW[cc] if cc in ASIA_RAW else RAW[cc])
    src = raw if os.path.isabs(raw) else os.path.join(ASIA_DIR if cc in ASIA_RAW else CHAMP_DIR, raw)
    dst = os.path.join(OUT_DIR, cc + '.webp')
    mp.make(src, dst, tint='#8a4a30', ring_path=rp)
    print('wrote', dst)


if __name__ == '__main__':
    main()

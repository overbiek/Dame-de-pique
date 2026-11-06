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
OUT_DIR = os.environ.get('WT_LOCALS_OUT') or os.path.join(ROOT, 'public', 'campaign', 'worldtour', 'locals')
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


def cutout_model(img):
    """Backdrop removal that models the backdrop instead of guessing a brightness band. The default make_portrait.cutout treats any
    low-saturation mid-grey pixel as backdrop, which eats grey and white hair and beards (holes in a white beard, bites in white hair) and
    misses backdrop patches that are a little lighter or darker than the band (grey islands beside a head). Here the smooth backdrop (a flat
    grey with a soft gradient) is fitted from the picture's top and side strips as a quadratic surface per channel, and a pixel is backdrop
    only if it matches that surface AND is connected to the border."""
    from scipy import ndimage as ndi
    rgb = img.convert('RGB'); a = np.asarray(rgb).astype(np.float32)
    h, w, _ = a.shape
    sm = np.stack([ndi.gaussian_filter(a[..., c], 1.4) for c in range(3)], -1)
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32); xn, yn = xs / w - .5, ys / h - .5
    A = np.stack([np.ones_like(xn), xn, yn, xn * xn, xn * yn, yn * yn], -1)
    strip = np.zeros((h, w), bool); t = 36
    strip[:t, :] = True                                    # top
    strip[:int(h * .55), :t] = True; strip[:int(h * .55), -t:] = True   # sides, down to where the shoulders start
    use = strip.copy(); model = np.zeros_like(a)
    for _ in range(4):                                     # robust fit: drop what does not agree (hair tips, an ear at the strip)
        M = A[use]; coef = [np.linalg.lstsq(M, sm[..., c][use], rcond=None)[0] for c in range(3)]
        model = np.stack([A @ coef[c] for c in range(3)], -1)
        res = np.abs(sm - model).max(-1)
        use = strip & (res < 14)
    res = np.abs(sm - model).max(-1)
    cand = res < float(os.environ.get('WT_TOL', '15'))     # tighten (e.g. 9) when a grey garment is close to the backdrop colour
    cand = ndi.binary_opening(cand, np.ones((3, 3), bool), iterations=2)       # cut thin bridges (single hairs) into the person
    lab, n = ndi.label(cand)
    edge = set(np.unique(np.concatenate([lab[0, :], lab[:, 0], lab[:, -1], lab[-1, :]]))) - {0}
    bgm = np.isin(lab, list(edge))
    bg = Image.fromarray(np.where(bgm, 255, 0).astype(np.uint8), 'L').filter(ImageFilter.MaxFilter(3))
    alpha = ImageChops.invert(bg).filter(ImageFilter.GaussianBlur(1.3))
    solid = alpha.point(lambda v: 255 if v > 128 else 0).copy()
    seed = next(((x, y) for y in (int(S * .62), int(S * .7), int(S * .55)) for x in (S // 2, S // 2 - 60, S // 2 + 60) if solid.getpixel((x, y)) == 255), None)
    if seed:                                               # keep only the component that holds the person
        ImageDraw.floodfill(solid, seed, 128)
        keep = Image.fromarray(np.where(np.asarray(solid) == 128, 255, 0).astype(np.uint8), 'L').filter(ImageFilter.MaxFilter(3))
        alpha = ImageChops.multiply(alpha, keep)
    out = rgb.convert('RGBA'); out.putalpha(alpha)
    return out


if os.environ.get('WT_CUTOUT') == 'model':
    mp.cutout = cutout_model


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

"""World Tour octagon portrait.
DEFAULT (bake): the image tool draws the octagon ring itself; this just makes the black corners transparent and resizes to 512.
Optional --compose: the older mode that cuts a person out of a grey backdrop and draws our own frame (kept as a fallback).

  make_portrait.py IN.png OUT.webp [--tint "#c07040"] [--no-cutout] [--crop 0.78] [--scale 0.9] [--accent "#8a2b3a"]

IN  : 1024 square head-and-shoulders on a plain flat grey backdrop (see look-bible-europe.md section 2).
      --no-cutout  use the picture as it is (for stand-in tests with pictures that already have a backdrop).
      --crop       fraction of the picture to keep, centred (for stand-ins that carry a ring we want to drop).
OUT : 512 x 512 WebP with transparent corners.
Frame geometry is in one place (GEOM) so a later frame change is one edit + one batch re-run.
"""
import sys, math, argparse
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageChops

import os
CUT_SAT = int(os.environ.get('WT_CUT_SAT', '40'))   # raise (e.g. 62) for a warm/brown backdrop instead of neutral grey
S = 1024                      # working size, downsampled to 512 at the end
C = S // 2
GEOM = dict(
    star_ro=498, star_ri=392,      # eight-point Great Eight star behind the frame
    frame_apo=424,                 # apothem (centre to side) of the outer brass octagon
    face_apo=372,                  # apothem of the portrait window
    hair_apo=392,                  # fine dark hairline inside the brass
    seal_r=58,                     # lozenge at the bottom centre
)
BRASS = [(0.0, (238, 208, 142)), (0.5, (196, 158, 88)), (1.0, (128, 100, 54))]


def octagon(apo, cx=C, cy=C, flat_top=True):
    r = apo / math.cos(math.radians(22.5))
    off = 22.5 if flat_top else 0.0
    return [(cx + r * math.cos(math.radians(off + 45 * k + 90)), cy + r * math.sin(math.radians(off + 45 * k + 90))) for k in range(8)]


def star(ro, ri, cx=C, cy=C):
    pts = []
    for k in range(16):
        a = math.radians(-90 + 22.5 * k)
        r = ro if k % 2 == 0 else ri
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def mask_of(poly):
    m = Image.new('L', (S, S), 0)
    ImageDraw.Draw(m).polygon(poly, fill=255)
    return m


def gradient(stops, angle=-45):
    """Diagonal metal gradient, light top-left to dark bottom-right."""
    y, x = np.mgrid[0:S, 0:S].astype(np.float32)
    a = math.radians(angle)
    t = ((x - C) * math.cos(a) + (y - C) * math.sin(a)) / (S * 0.9) + 0.5
    t = np.clip(1 - t, 0, 1)
    out = np.zeros((S, S, 3), np.float32)
    for i in range(len(stops) - 1):
        t0, c0 = stops[i]; t1, c1 = stops[i + 1]
        w = np.clip((t - t0) / (t1 - t0), 0, 1)[..., None]
        seg = (t >= t0) & (t <= t1 + 1e-6)
        out = np.where(seg[..., None], np.array(c0) * (1 - w) + np.array(c1) * w, out)
    return Image.fromarray(out.astype(np.uint8), 'RGB')


def hex2rgb(h):
    h = h.lstrip('#'); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def cutout(img):
    """Remove a flat/soft-gradient grey backdrop. A pixel is backdrop if it is low-saturation AND mid-brightness
    (the black coat is far darker, skin/hair are far more saturated) AND connected to the picture border."""
    rgb = img.convert('RGB')
    hsv = np.asarray(rgb.convert('HSV')).astype(np.int16)
    cand = (hsv[..., 1] < CUT_SAT) & (hsv[..., 2] > 70) & (hsv[..., 2] < 205)   # CUT_SAT: a warm taupe backdrop (charmer house) sits at ~42, above the old 40
    m = Image.fromarray(np.where(cand, 255, 0).astype(np.uint8), 'L').copy()   # .copy(): fromarray images are read-only, floodfill would silently do nothing
    for xy in [(x, 0) for x in range(0, S, 64)] + [(x, S - 1) for x in range(0, S, 64)] + [(0, y) for y in range(0, S, 64)] + [(S - 1, y) for y in range(0, S, 64)]:
        if m.getpixel(xy) == 255:
            ImageDraw.floodfill(m, xy, 128)
    arr = np.asarray(m)
    bgm = (arr == 128)
    # Second pass: tolerance flood fill from the border on the colour image itself. The brightness/saturation band above misses a
    # backdrop that is lighter or darker than expected in a corner (a grey rectangle was left behind on one portrait), and leaves
    # speckles where JPEG noise crosses the band edge. Seeds are every 48px along the border; each fills what is close to its own colour.
    tmp = rgb.copy()
    MARK = (255, 0, 255)
    ref = np.median(np.concatenate([np.asarray(rgb)[:40, :80].reshape(-1, 3), np.asarray(rgb)[:40, -80:].reshape(-1, 3)]), axis=0)   # backdrop colour from the two top corners
    for xy in [(x, 0) for x in range(0, S, 48)] + [(x, S - 1) for x in range(0, S, 48)] + [(0, y) for y in range(0, S, 48)] + [(S - 1, y) for y in range(0, S, 48)]:
        px_ = tmp.getpixel(xy)
        if px_ != MARK and max(abs(int(px_[i]) - float(ref[i])) for i in range(3)) < 34:
            ImageDraw.floodfill(tmp, xy, MARK, thresh=22)
    flood = (np.asarray(tmp)[..., 0] == 255) & (np.asarray(tmp)[..., 1] == 0) & (np.asarray(tmp)[..., 2] == 255)
    bgm = bgm | flood
    bg = Image.fromarray(np.where(bgm, 255, 0).astype(np.uint8), 'L')
    bg = bg.filter(ImageFilter.MaxFilter(3))                      # grow backdrop by 1px = shave the grey halo off the person
    alpha = ImageChops.invert(bg).filter(ImageFilter.GaussianBlur(1.3))
    # keep only the component that contains the person (a point on the chest/neck area); isolated specks and patches of backdrop disappear
    solid = alpha.point(lambda v: 255 if v > 128 else 0).copy()
    seed = next(((x, y) for y in (int(S * .62), int(S * .7), int(S * .55)) for x in (S // 2, S // 2 - 60, S // 2 + 60) if solid.getpixel((x, y)) == 255), None)
    if seed:
        ImageDraw.floodfill(solid, seed, 128)
        keep = Image.fromarray(np.where(np.asarray(solid) == 128, 255, 0).astype(np.uint8), 'L').filter(ImageFilter.MaxFilter(3))
        alpha = ImageChops.multiply(alpha, keep)
    out = rgb.convert('RGBA'); out.putalpha(alpha)
    return out


def head_metrics(alpha):
    """Where the head is, from the silhouette alone (no face detector): hair top, head width (the widest row between 5% and 28% of the
    picture height below the hair top: hair and ears, before the shoulders or a collar flare) and the head's horizontal centre."""
    A = np.asarray(alpha) > 128
    rows = np.where(A.any(1))[0]
    y_t = int(rows[0])
    w = np.convolve(A.sum(1).astype(np.float32), np.ones(9) / 9, mode='same')
    ya, yb = y_t + int(.05 * S), y_t + int(.28 * S)
    hw = float(w[ya:yb].max())
    cols = [np.where(A[y])[0] for y in range(ya, yb) if A[y].any()]
    cx = float(np.mean([(c[0] + c[-1]) / 2 for c in cols])) if cols else S / 2
    return y_t, hw, cx


def backdrop(tint):
    """Soft city-tinted glow, brightest behind the head, falling to near-black at the edges."""
    y, x = np.mgrid[0:S, 0:S].astype(np.float32)
    d = np.sqrt((x - C) ** 2 + (y - C * 0.82) ** 2) / (S * 0.62)
    k = np.clip(1 - d, 0, 1) ** 1.6
    base = np.array((7, 26, 21), np.float32); glow = np.array(hex2rgb(tint), np.float32) * 0.62
    arr = base[None, None, :] * (1 - k[..., None]) + glow[None, None, :] * k[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), 'RGB').convert('RGBA')


def dilate_oct(mask, r):
    """Grow a boolean mask by r px with an OCTAGONAL kernel (alternating 3x3 square and cross steps), so a regular octagon stays regular."""
    m = mask.copy()
    for i in range(r):
        g = m.copy()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            g |= np.roll(np.roll(m, dy, 0), dx, 1)
        if i % 2 == 0:
            for dy, dx in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
                g |= np.roll(np.roll(m, dy, 0), dx, 1)
        m = g
    return m


def thin_ring(ring, thin, protect=(430, 860, 594, 1016)):
    """Make the rim thinner by cutting `thin` px off its INNER side (the window grows), keeping the outer ornate band and the bottom seal."""
    a = np.asarray(ring.getchannel('A')).copy()
    hole = ring_window(ring); h = np.asarray(hole) > 0
    grown = dilate_oct(h, thin)
    x0, y0, x1, y1 = protect
    keep = np.zeros_like(grown); keep[y0:y1, x0:x1] = True                         # leave the seal at the bottom untouched
    newhole = (grown & ~keep) | h
    lip_outer = dilate_oct(newhole, 6) & ~newhole & (a > 12)                       # a thin gold lip along the new inner edge
    a2 = np.where(newhole, 0, a).astype(np.uint8)
    rgb = np.asarray(ring.convert('RGB')).copy()
    lip = np.array((205, 165, 88), np.uint8)
    t = np.linspace(0, 1, 1)[0]
    rgb[lip_outer] = (0.35 * rgb[lip_outer] + 0.65 * lip).astype(np.uint8)
    out = Image.fromarray(rgb, 'RGB').convert('RGBA'); out.putalpha(Image.fromarray(a2, 'L'))
    return out


def prep_ring(inp, outp, keep_center=False, thin=0):
    """Turn a ring picture (gold ring on solid black, black outside AND inside) into a transparent-PNG ring.
    Black connected to the border = outside; black connected to the centre = the window. Both become transparent."""
    img = Image.open(inp).convert('RGB').resize((S, S), Image.LANCZOS)
    v = np.asarray(img.convert('HSV'))[..., 2]
    m = Image.fromarray(np.where(v < 34, 255, 0).astype(np.uint8), 'L').copy()
    seeds = [(x, 0) for x in range(0, S, 32)] + [(x, S - 1) for x in range(0, S, 32)] + [(0, y) for y in range(0, S, 32)] + [(S - 1, y) for y in range(0, S, 32)] + ([] if keep_center else [(C, C)])
    for xy in seeds:
        if m.getpixel(xy) == 255:
            ImageDraw.floodfill(m, xy, 128)
    hole = Image.fromarray(np.where(np.asarray(m) == 128, 255, 0).astype(np.uint8), 'L').filter(ImageFilter.MaxFilter(3))
    out = img.convert('RGBA'); out.putalpha(ImageChops.invert(hole).filter(ImageFilter.GaussianBlur(0.8)))
    if thin and not keep_center:
        out = thin_ring(out, thin)
    out.save(outp)


def ring_window(ring):
    """Transparent region connected to the centre of a prepared ring = the portrait window."""
    a = ring.getchannel('A').point(lambda x: 255 if x < 12 else 0)
    ImageDraw.floodfill(a, (C, C), 128)
    return Image.fromarray(np.where(np.asarray(a) == 128, 255, 0).astype(np.uint8), 'L')


HEAD_FRAC = 0.47   # head width (hair and ears) as a fraction of the window width, the same for every portrait


def make(inp, outp, tint='#8a6a3a', no_cutout=False, crop=1.0, accent=None, scale=0.0, ring_path=None, frac=0.68):
    src = Image.open(inp).convert('RGB')
    if crop < 1.0:
        w, h = src.size; cw, ch = int(w * crop), int(h * crop)
        src = src.crop(((w - cw) // 2, (h - ch) // 2, (w - cw) // 2 + cw, (h - ch) // 2 + ch))
    src = src.resize((S, S), Image.LANCZOS)
    person = src.convert('RGBA') if no_cutout else cutout(src)

    ring_img = Image.open(ring_path).convert('RGBA').resize((S, S), Image.LANCZOS) if ring_path else None
    window = ring_window(ring_img) if ring_img else mask_of(octagon(GEOM['face_apo']))
    wb = window.getbbox()                                                    # window box: left, top, right, bottom
    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    if no_cutout:
        layer.paste(person, (0, 0))
    else:
        layer.alpha_composite(backdrop(tint))
        wh = wb[3] - wb[1]; ww = wb[2] - wb[0]
        top_pad = 0.10 * wh                                                              # clear space above the hair, always
        y_t, hw, cx = head_metrics(person.getchannel('A'))
        if scale and scale > 0:
            sc_ = scale
        else:                                                                           # same head size in every portrait: head width = HEAD_FRAC of the window width
            sc_ = (HEAD_FRAC * ww) / max(40.0, hw)
        n = int(S * sc_); person = person.resize((n, n), Image.LANCZOS)
        px = int((wb[0] + ww / 2) - cx * sc_)                                            # head centred horizontally in the window
        py = int(wb[1] + top_pad - y_t * sc_)                                            # hair top lands exactly top_pad below the window top
        holder = Image.new('RGBA', (S, S), (0, 0, 0, 0)); holder.paste(person, (px, py)); person = holder
        layer.alpha_composite(person)
    layer.putalpha(ImageChops.multiply(layer.getchannel('A'), window))

    canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    if ring_img:
        canvas.alpha_composite(layer); canvas.alpha_composite(ring_img)
        res = canvas.resize((512, 512), Image.LANCZOS)
        res.save(outp, quality=90, method=5) if str(outp).lower().endswith('.webp') else res.save(outp)
        return
    # 1) Great Eight star behind everything (dark brass, thin bright edge)
    star_poly = star(GEOM['star_ro'], GEOM['star_ri'])
    sm = mask_of(star_poly)
    dark = gradient([(0, (150, 118, 62)), (1, (70, 52, 26))])
    canvas.paste(dark, (0, 0), sm)
    ImageDraw.Draw(canvas).line(star_poly + [star_poly[0]], fill=(238, 208, 142, 200), width=3)
    # 2) brass octagon ring
    outer = mask_of(octagon(GEOM['frame_apo']))
    ring = ImageChops.subtract(outer, window)
    canvas.paste(gradient(BRASS), (0, 0), ring)
    d = ImageDraw.Draw(canvas)
    hp = octagon(GEOM['hair_apo']); d.line(hp + [hp[0]], fill=(60, 42, 16, 230), width=3)     # engraved hairline
    op = octagon(GEOM['frame_apo']); d.line(op + [op[0]], fill=(255, 236, 180, 255), width=3)   # outer highlight
    ip = octagon(GEOM['face_apo']); d.line(ip + [ip[0]], fill=(50, 34, 12, 255), width=5)       # inner shadow edge
    if accent:                                                                                   # optional per-member accent line
        ap = octagon(GEOM['face_apo'] + 14); d.line(ap + [ap[0]], fill=hex2rgb(accent) + (255,), width=6)
    # 3) the portrait
    canvas.alpha_composite(layer)
    # 4) seal lozenge, bottom centre, overlapping the frame
    sx, sy, r = C, C + GEOM['frame_apo'], GEOM['seal_r']
    seal_o = mask_of(octagon(r, sx, sy)); seal_i = mask_of(octagon(r - 13, sx, sy))
    canvas.paste(gradient(BRASS), (0, 0), seal_o)
    canvas.paste(Image.new('RGBA', (S, S), (13, 46, 37, 255)), (0, 0), seal_i)
    d = ImageDraw.Draw(canvas)
    sp = octagon(r, sx, sy); d.line(sp + [sp[0]], fill=(255, 236, 180, 255), width=2)
    d.polygon(star(r - 20, r - 34, sx, sy), fill=(238, 208, 142, 255))
    canvas.resize((512, 512), Image.LANCZOS).save(outp, quality=88, method=5) if str(outp).lower().endswith('.webp') else canvas.resize((512, 512), Image.LANCZOS).save(outp)


def bake(inp, outp, size=512):
    """DEFAULT mode: the image tool already drew the octagon ring. Turn the solid-black corners (outside the ring and star points)
    transparent, trim to the artwork and resize. Black counts as backdrop only if it is connected to the picture border, so the
    black coat and dark areas INSIDE the ring are untouched."""
    img = Image.open(inp).convert('RGB').resize((S, S), Image.LANCZOS)
    v = np.asarray(img.convert('HSV'))[..., 2]
    m = Image.fromarray(np.where(v < 34, 255, 0).astype(np.uint8), 'L').copy()
    seeds = [(x, 0) for x in range(0, S, 32)] + [(x, S - 1) for x in range(0, S, 32)] + [(0, y) for y in range(0, S, 32)] + [(S - 1, y) for y in range(0, S, 32)]
    for xy in seeds:
        if m.getpixel(xy) == 255:
            ImageDraw.floodfill(m, xy, 128)
    bg = Image.fromarray(np.where(np.asarray(m) == 128, 255, 0).astype(np.uint8), 'L')
    bg = bg.filter(ImageFilter.MaxFilter(3))                                   # eat the dark fringe on the ring edge
    out = img.convert('RGBA'); out.putalpha(ImageChops.invert(bg).filter(ImageFilter.GaussianBlur(1.0)))
    box = out.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
    if box:
        out = out.crop(box)
        side = max(out.size); sq = Image.new('RGBA', (side, side), (0, 0, 0, 0)); sq.paste(out, ((side - out.width) // 2, (side - out.height) // 2)); out = sq
    out = out.resize((size, size), Image.LANCZOS)
    out.save(outp, quality=90, method=5) if str(outp).lower().endswith('.webp') else out.save(outp)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('inp'); ap.add_argument('outp')
    ap.add_argument('--tint', default='#8a6a3a'); ap.add_argument('--no-cutout', action='store_true')
    ap.add_argument('--crop', type=float, default=1.0); ap.add_argument('--accent', default=None); ap.add_argument('--frac', type=float, default=0.68, help='share of the person (hair to bottom edge) shown in the window; smaller = bigger face'); ap.add_argument('--scale', type=float, default=0.0, help='0 = auto-fit (default)'); ap.add_argument('--ring', default=None, help='prepared ring PNG made with --prep-ring'); ap.add_argument('--prep-ring', action='store_true', help='inp = ring picture on black, outp = transparent ring PNG'); ap.add_argument('--thin', type=int, default=0, help='with --prep-ring: cut this many px off the inner side of the rim (about 55 = half as thick)'); ap.add_argument('--keep-center', action='store_true', help='with --prep-ring: only remove the OUTSIDE black (level ring)'); ap.add_argument('--compose', action='store_true', help='old mode: draw our own octagon frame around a grey-backdrop photo')
    a = ap.parse_args()
    if a.prep_ring:
        prep_ring(a.inp, a.outp, a.keep_center, a.thin)
    elif a.compose or a.ring:
        make(a.inp, a.outp, a.tint, a.no_cutout, a.crop, a.accent, a.scale, a.ring, a.frac)
    else:
        bake(a.inp, a.outp)

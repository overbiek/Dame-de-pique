# World Tour gold seals: prompts (one seal per country, 60 in total)

The gold seal marks a cleared table in that country. The game draws the table number on top (with a dark outline, so a bright enamel is fine), so **the centre must stay clear and calm** and the number is never part of the picture. Same family as the gold medallions of the first campaign (`public/campaign/gold/*.webp`): ornate gold filigree, jewels, dark damask enamel. The difference is the shape: the World Tour uses the **octagon with the eight-point star** (the Great Eight ring, `rings/ring_level.png`).

**Colour rule (Robin, 2026-11-02):** **gold is the main colour of every crest** (rim, scrollwork, star, emblem, claws are all polished gold, never silver, black or coloured metal). The country's known colours come back only in the **enamel** (the plate, plus a thin band around its edge) and the **gems**. Keep the enamel plate to about 60% of the seal's width so the gold stays dominant. The centre stays calm.

## Attach every time (style references)
1. `public/campaign/gold/1.webp`, `public/campaign/gold/301.webp` and `public/campaign/gold/400.webp` (the first campaign's gold medallions).
2. `campaign-design/worldtour-art/rings/ring_level.png` (the octagon frame; the prompt tells Gemini to ignore its green).

## Output spec
- Square 1:1, 1254 x 1254 or larger, the seal centred and filling about 85% of the frame.
- **Pure black background (#000000)**, nothing else in the picture (the same cut-out as the old medallions). No glow, drop shadow, reflection or vignette outside the seal.
- No text, no letters, no numbers, no flag, no watermark. The number is drawn by the game.
- The outer rim must be **solid and closed** (no pierced openwork): earlier medallions with gaps let the black leak into the enamel when cut out.

## How to work (this is what keeps all 60 looking like a set)
1. **Step A, once:** make the Italy master with the master prompt. Check it (list below), then it is the approved master.
2. **Step B, every other country:** same chat, attach the approved Italy seal and use the Step B prompt. Only enamel, band, gems and emblem change.
3. Do all of one continent in the same chat, one after the other.

## Step A: master prompt (fill {ENAMEL}, {BAND}, {GEM}, {MOTIF} from the table)
```
Create ONE ornate gold seal medallion for a luxury card game, on a pure black (#000000) background.

STYLE: match the attached round gold medallions: polished antique gold, fine filigree scrollwork, small faceted jewels, dark enamel centre, soft warm highlights, realistic metal. Copy their craftsmanship and lighting only, NOT their round shape.
SHAPE: copy the attached octagon ring's shape and proportions (ignore its green colour). A REGULAR OCTAGON, eight equal straight sides, one flat side on top, NOT round. The outer rim is solid and closed: no cut-outs, no pierced openwork, no gaps, with fine scrollwork in relief on it.
TOP: a small eight-point star centred on the top of the rim.
CORNERS: one faceted {GEM} at each of the four diagonal corners of the rim, all four identical, set in gold claws.
BOTTOM: centred on the lower rim, one bold gold relief emblem of {MOTIF}: a simple, chunky silhouette that still reads when the whole seal is only 80 pixels wide.
COLOUR: gold is the dominant colour of the whole seal. ALL metal is polished antique gold (rim, scrollwork, star, emblem, jewel claws); no silver, black or coloured metal. National colours appear ONLY in the enamel and the jewels.
CENTRE: a recessed octagonal plate, about 60% of the seal's width, of rich, saturated {ENAMEL} enamel, glossy like fired enamel. Around the inside edge of the plate runs a thin enamel band of {BAND}, bordered in gold. A barely visible tone-on-tone damask pattern on the plate, at most 10% lighter or darker than the base, and the middle two-thirds of the plate perfectly calm and empty, because a large number will be placed there later.

BACKGROUND AND OUTPUT: square 1:1, 1254 x 1254 or larger, seal centred and filling about 85% of the frame. Nothing outside the seal: no glow, no drop shadow, no reflection, no vignette, no ground. No text, letters, numbers, flag or watermark anywhere.
```

## Step B: the other countries (attach the approved Italy seal)
```
Attached is the approved seal. Make the identical seal for {COUNTRY}. Change ONLY four things: the enamel plate colour to {ENAMEL}, the thin inner band to {BAND}, the four corner jewels to {GEM}, and the bottom emblem to {MOTIF}. The rim, scrollwork, star, octagon proportions, lighting, size, position and the pure black background must stay exactly the same. All metal stays polished gold and gold stays the dominant colour: the national colours appear only in the enamel and the jewels. Same rules: solid closed outer rim, calm empty centre, no text, letters, numbers or flag, no glow or shadow.
```

## Europe (10 seals)

| Country | {ENAMEL} | {BAND} | {GEM} | {MOTIF} |
|---|---|---|---|---|
| Italy (Rome) | rich emerald green | ivory white with a fine red line | ruby | the two-tier arcade of the Colosseum |
| Spain (Madrid) | rich crimson red | golden yellow | amber | a charging Spanish fighting bull with its horns lowered |
| Portugal (Porto) | deep crimson red | emerald green | emerald | an armillary sphere |
| Netherlands (Rotterdam) | bright Oranje orange | navy blue | sapphire | a single tulip |
| United Kingdom (London) | deep navy blue | red with a fine white line | ruby | the Big Ben clock tower |
| Belgium (Brussels) | black | yellow | ruby | a small classical fountain statue of a little boy on a stone pedestal, simple silhouette, tiny arc of water into a basin (do NOT write the statue's name, Gemini refuses it; fallback if it refuses anyway: the Atomium, nine spheres joined by tubes) |
| Germany (Berlin) | charcoal black | red with a fine gold line | amber | the Brandenburg Gate with its columns |
| Poland (Warsaw) | deep crimson red | ivory white | pearl | a crowned eagle |
| Denmark (Copenhagen) | bright scarlet red | white | pearl | a Viking longship |
| France (Paris) | bright royal blue | white with a fine red line | diamond | the Arc de Triomphe beside the Eiffel Tower |

Overlaps that cannot be avoided (real national colours): Spain, Portugal and Poland are all red (band, gem and emblem separate them); Poland is darker than Denmark's bright scarlet; Belgium and Germany are both black (yellow band with ruby versus red and gold band with amber).

## Asia (10 seals)

**Changed 2026-11-03 (Robin: bands too big, the centre needs more room for the character, like the Great Eight ring):** the Europe seals have a plate of only ~63% of the seal's width (the Great Eight ring's window is 76%). For Asia the gold rim is thin (~6% a side), the plate is ~76% wide, the enamel band is a hairline, the gems and the emblem are small and the emblem barely rises into the plate (so it no longer covers the portrait). Do NOT attach the Italy seal for Asia: it has the wide rim and would copy it. Use the complete prompts below for the first seal, and once it is approved attach THAT seal for the other nine (short Step B prompts at the end). Each emblem is the country's signature, a simple chunky silhouette that still reads at 80 pixels.

| Country | {ENAMEL} | {BAND} | {GEM} | {MOTIF} (the signature) |
|---|---|---|---|---|
| Saudi Arabia (Riyadh) | emerald green | ivory white | emerald | a date palm tree above two crossed curved swords |
| India (Mumbai) | deep saffron orange | emerald green with a fine white line | citrine | the Taj Mahal, with a central onion dome flanked by four slender minarets |
| Thailand (Bangkok) | deep royal blue | red with a fine white line | sapphire | an elephant seen from the side with its trunk raised |
| Vietnam (Ho Chi Minh City) | bright lacquer red | golden yellow | ruby | a single lotus flower in bloom |
| Philippines (Manila) | bright turquoise sea blue | golden yellow | pearl | a jeepney, the long Filipino jeep-bus, in side view with its long bonnet and curved roof |
| Indonesia (Jakarta) | deep burgundy red | ivory white | garnet | Borobudur, a stepped temple mound crowned by a bell-shaped stupa |
| Taiwan (Taipei) | deep jade teal | white with a fine red line | aquamarine | Taipei 101, the tall tower built from eight stacked, flared sections |
| China (Shanghai) | ink-black lacquer | imperial red | jade | a three-tier Chinese pagoda with upturned eaves |
| South Korea (Seoul) | celadon green | white with a fine blue line | diamond | a Korean palace gate with a curved, tiled roof |
| Japan (Tokyo) | deep sakura rose pink | ivory white with a fine red line | pink sapphire | a cherry blossom (sakura) tree in bloom, with a bent trunk and a rounded crown of blossom |

Overlaps that cannot be avoided (shared national colours): Vietnam is bright red and Indonesia deep burgundy (separate by tone, band, gem and emblem); Thailand's royal blue and Korea's celadon are the only cool plates next to Taiwan's teal and the Philippines' turquoise, so keep each of them clearly its own tone; China is the only black plate in Asia. If Gemini draws the jeepney as a plain bus, say "a colourful Filipino jeepney with a long bonnet and a curved metal roof". If the Taj Mahal comes back too detailed, say "a plain dome with four slim minarets, no windows". Alternatives if one emblem will not read: Vietnam the conical leaf hat, China a sitting giant panda, Korea a crouching tiger, Indonesia a Garuda with spread wings, Japan Mount Fuji with a single sakura branch.

### Complete prompts per country (standalone, no master needed)
Each is the full Step A master prompt with that country's gem, emblem, enamel and band filled in. Use these if you start a fresh chat or the Italy master is not attached; keep attaching the same style references (the three gold medallions plus the octagon ring).

**Saudi Arabia (Riyadh)**
```
Create ONE ornate gold seal medallion for a luxury card game, on a pure black (#000000) background.

STYLE: match the attached round gold medallions: polished antique gold, fine filigree scrollwork, small faceted jewels, dark enamel centre, soft warm highlights, realistic metal. Copy their craftsmanship and lighting only, NOT their round shape.
SHAPE: copy the attached octagon ring's shape and proportions (ignore its green colour). A REGULAR OCTAGON, eight equal straight sides, one flat side on top, NOT round. The outer rim is solid and closed: no cut-outs, no pierced openwork, no gaps, with fine scrollwork in relief on it. THE RIM IS THIN AND NARROW: the whole gold border band is only about 6% of the seal's width on each side, so the centre plate takes up almost the entire seal.
TOP: a small eight-point star centred on the top of the rim, sitting within the thin rim.
CORNERS: one small faceted emerald at each of the four diagonal corners of the rim, all four identical, set in gold claws.
BOTTOM: centred on the lower rim, one small, compact gold relief emblem of a date palm tree above two crossed curved swords: a simple, chunky silhouette that still reads when the whole seal is only 80 pixels wide. It sits on the thin lower rim and rises only slightly into the plate, no more than about 5% of the seal's height.
COLOUR: gold is the dominant colour of the whole seal. ALL metal is polished antique gold (rim, scrollwork, star, emblem, jewel claws); no silver, black or coloured metal. National colours appear ONLY in the enamel and the jewels.
CENTRE: a recessed octagonal plate, about 76% of the seal's width (as large as the plate of the attached octagon ring allows), of rich, saturated emerald green enamel, glossy like fired enamel. Around the inside edge of the plate runs only a hairline enamel line of ivory white, no wider than 1.5% of the seal's width, bordered by a fine gold line. A barely visible tone-on-tone damask pattern on the plate, at most 10% lighter or darker than the base, and the middle three-quarters of the plate perfectly calm and empty, because a character portrait and a large number will be placed there later.

BACKGROUND AND OUTPUT: square 1:1, 1254 x 1254 or larger, seal centred and filling about 85% of the frame. Nothing outside the seal: no glow, no drop shadow, no reflection, no vignette, no ground. No text, letters, numbers, flag or watermark anywhere.
```

**India (Mumbai)**
```
Create ONE ornate gold seal medallion for a luxury card game, on a pure black (#000000) background.

STYLE: match the attached round gold medallions: polished antique gold, fine filigree scrollwork, small faceted jewels, dark enamel centre, soft warm highlights, realistic metal. Copy their craftsmanship and lighting only, NOT their round shape.
SHAPE: copy the attached octagon ring's shape and proportions (ignore its green colour). A REGULAR OCTAGON, eight equal straight sides, one flat side on top, NOT round. The outer rim is solid and closed: no cut-outs, no pierced openwork, no gaps, with fine scrollwork in relief on it. THE RIM IS THIN AND NARROW: the whole gold border band is only about 6% of the seal's width on each side, so the centre plate takes up almost the entire seal.
TOP: a small eight-point star centred on the top of the rim, sitting within the thin rim.
CORNERS: one small faceted citrine at each of the four diagonal corners of the rim, all four identical, set in gold claws.
BOTTOM: centred on the lower rim, one small, compact gold relief emblem of the Taj Mahal, with a central onion dome flanked by four slender minarets: a simple, chunky silhouette that still reads when the whole seal is only 80 pixels wide. It sits on the thin lower rim and rises only slightly into the plate, no more than about 5% of the seal's height.
COLOUR: gold is the dominant colour of the whole seal. ALL metal is polished antique gold (rim, scrollwork, star, emblem, jewel claws); no silver, black or coloured metal. National colours appear ONLY in the enamel and the jewels.
CENTRE: a recessed octagonal plate, about 76% of the seal's width (as large as the plate of the attached octagon ring allows), of rich, saturated deep saffron orange enamel, glossy like fired enamel. Around the inside edge of the plate runs only a hairline enamel line of emerald green with a fine white line, no wider than 1.5% of the seal's width, bordered by a fine gold line. A barely visible tone-on-tone damask pattern on the plate, at most 10% lighter or darker than the base, and the middle three-quarters of the plate perfectly calm and empty, because a character portrait and a large number will be placed there later.

BACKGROUND AND OUTPUT: square 1:1, 1254 x 1254 or larger, seal centred and filling about 85% of the frame. Nothing outside the seal: no glow, no drop shadow, no reflection, no vignette, no ground. No text, letters, numbers, flag or watermark anywhere.
```

**Thailand (Bangkok)**
```
Create ONE ornate gold seal medallion for a luxury card game, on a pure black (#000000) background.

STYLE: match the attached round gold medallions: polished antique gold, fine filigree scrollwork, small faceted jewels, dark enamel centre, soft warm highlights, realistic metal. Copy their craftsmanship and lighting only, NOT their round shape.
SHAPE: copy the attached octagon ring's shape and proportions (ignore its green colour). A REGULAR OCTAGON, eight equal straight sides, one flat side on top, NOT round. The outer rim is solid and closed: no cut-outs, no pierced openwork, no gaps, with fine scrollwork in relief on it. THE RIM IS THIN AND NARROW: the whole gold border band is only about 6% of the seal's width on each side, so the centre plate takes up almost the entire seal.
TOP: a small eight-point star centred on the top of the rim, sitting within the thin rim.
CORNERS: one small faceted sapphire at each of the four diagonal corners of the rim, all four identical, set in gold claws.
BOTTOM: centred on the lower rim, one small, compact gold relief emblem of an elephant seen from the side with its trunk raised: a simple, chunky silhouette that still reads when the whole seal is only 80 pixels wide. It sits on the thin lower rim and rises only slightly into the plate, no more than about 5% of the seal's height.
COLOUR: gold is the dominant colour of the whole seal. ALL metal is polished antique gold (rim, scrollwork, star, emblem, jewel claws); no silver, black or coloured metal. National colours appear ONLY in the enamel and the jewels.
CENTRE: a recessed octagonal plate, about 76% of the seal's width (as large as the plate of the attached octagon ring allows), of rich, saturated deep royal blue enamel, glossy like fired enamel. Around the inside edge of the plate runs only a hairline enamel line of red with a fine white line, no wider than 1.5% of the seal's width, bordered by a fine gold line. A barely visible tone-on-tone damask pattern on the plate, at most 10% lighter or darker than the base, and the middle three-quarters of the plate perfectly calm and empty, because a character portrait and a large number will be placed there later.

BACKGROUND AND OUTPUT: square 1:1, 1254 x 1254 or larger, seal centred and filling about 85% of the frame. Nothing outside the seal: no glow, no drop shadow, no reflection, no vignette, no ground. No text, letters, numbers, flag or watermark anywhere.
```

**Vietnam (Ho Chi Minh City)**
```
Create ONE ornate gold seal medallion for a luxury card game, on a pure black (#000000) background.

STYLE: match the attached round gold medallions: polished antique gold, fine filigree scrollwork, small faceted jewels, dark enamel centre, soft warm highlights, realistic metal. Copy their craftsmanship and lighting only, NOT their round shape.
SHAPE: copy the attached octagon ring's shape and proportions (ignore its green colour). A REGULAR OCTAGON, eight equal straight sides, one flat side on top, NOT round. The outer rim is solid and closed: no cut-outs, no pierced openwork, no gaps, with fine scrollwork in relief on it. THE RIM IS THIN AND NARROW: the whole gold border band is only about 6% of the seal's width on each side, so the centre plate takes up almost the entire seal.
TOP: a small eight-point star centred on the top of the rim, sitting within the thin rim.
CORNERS: one small faceted ruby at each of the four diagonal corners of the rim, all four identical, set in gold claws.
BOTTOM: centred on the lower rim, one small, compact gold relief emblem of a single lotus flower in bloom: a simple, chunky silhouette that still reads when the whole seal is only 80 pixels wide. It sits on the thin lower rim and rises only slightly into the plate, no more than about 5% of the seal's height.
COLOUR: gold is the dominant colour of the whole seal. ALL metal is polished antique gold (rim, scrollwork, star, emblem, jewel claws); no silver, black or coloured metal. National colours appear ONLY in the enamel and the jewels.
CENTRE: a recessed octagonal plate, about 76% of the seal's width (as large as the plate of the attached octagon ring allows), of rich, saturated bright lacquer red enamel, glossy like fired enamel. Around the inside edge of the plate runs only a hairline enamel line of golden yellow, no wider than 1.5% of the seal's width, bordered by a fine gold line. A barely visible tone-on-tone damask pattern on the plate, at most 10% lighter or darker than the base, and the middle three-quarters of the plate perfectly calm and empty, because a character portrait and a large number will be placed there later.

BACKGROUND AND OUTPUT: square 1:1, 1254 x 1254 or larger, seal centred and filling about 85% of the frame. Nothing outside the seal: no glow, no drop shadow, no reflection, no vignette, no ground. No text, letters, numbers, flag or watermark anywhere.
```

**Philippines (Manila)**
```
Create ONE ornate gold seal medallion for a luxury card game, on a pure black (#000000) background.

STYLE: match the attached round gold medallions: polished antique gold, fine filigree scrollwork, small faceted jewels, dark enamel centre, soft warm highlights, realistic metal. Copy their craftsmanship and lighting only, NOT their round shape.
SHAPE: copy the attached octagon ring's shape and proportions (ignore its green colour). A REGULAR OCTAGON, eight equal straight sides, one flat side on top, NOT round. The outer rim is solid and closed: no cut-outs, no pierced openwork, no gaps, with fine scrollwork in relief on it. THE RIM IS THIN AND NARROW: the whole gold border band is only about 6% of the seal's width on each side, so the centre plate takes up almost the entire seal.
TOP: a small eight-point star centred on the top of the rim, sitting within the thin rim.
CORNERS: one small faceted pearl at each of the four diagonal corners of the rim, all four identical, set in gold claws.
BOTTOM: centred on the lower rim, one small, compact gold relief emblem of a jeepney, the long Filipino jeep-bus, in side view with its long bonnet and curved roof: a simple, chunky silhouette that still reads when the whole seal is only 80 pixels wide. It sits on the thin lower rim and rises only slightly into the plate, no more than about 5% of the seal's height.
COLOUR: gold is the dominant colour of the whole seal. ALL metal is polished antique gold (rim, scrollwork, star, emblem, jewel claws); no silver, black or coloured metal. National colours appear ONLY in the enamel and the jewels.
CENTRE: a recessed octagonal plate, about 76% of the seal's width (as large as the plate of the attached octagon ring allows), of rich, saturated bright turquoise sea blue enamel, glossy like fired enamel. Around the inside edge of the plate runs only a hairline enamel line of golden yellow, no wider than 1.5% of the seal's width, bordered by a fine gold line. A barely visible tone-on-tone damask pattern on the plate, at most 10% lighter or darker than the base, and the middle three-quarters of the plate perfectly calm and empty, because a character portrait and a large number will be placed there later.

BACKGROUND AND OUTPUT: square 1:1, 1254 x 1254 or larger, seal centred and filling about 85% of the frame. Nothing outside the seal: no glow, no drop shadow, no reflection, no vignette, no ground. No text, letters, numbers, flag or watermark anywhere.
```

**Indonesia (Jakarta)**
```
Create ONE ornate gold seal medallion for a luxury card game, on a pure black (#000000) background.

STYLE: match the attached round gold medallions: polished antique gold, fine filigree scrollwork, small faceted jewels, dark enamel centre, soft warm highlights, realistic metal. Copy their craftsmanship and lighting only, NOT their round shape.
SHAPE: copy the attached octagon ring's shape and proportions (ignore its green colour). A REGULAR OCTAGON, eight equal straight sides, one flat side on top, NOT round. The outer rim is solid and closed: no cut-outs, no pierced openwork, no gaps, with fine scrollwork in relief on it. THE RIM IS THIN AND NARROW: the whole gold border band is only about 6% of the seal's width on each side, so the centre plate takes up almost the entire seal.
TOP: a small eight-point star centred on the top of the rim, sitting within the thin rim.
CORNERS: one small faceted garnet at each of the four diagonal corners of the rim, all four identical, set in gold claws.
BOTTOM: centred on the lower rim, one small, compact gold relief emblem of Borobudur, a stepped temple mound crowned by a bell-shaped stupa: a simple, chunky silhouette that still reads when the whole seal is only 80 pixels wide. It sits on the thin lower rim and rises only slightly into the plate, no more than about 5% of the seal's height.
COLOUR: gold is the dominant colour of the whole seal. ALL metal is polished antique gold (rim, scrollwork, star, emblem, jewel claws); no silver, black or coloured metal. National colours appear ONLY in the enamel and the jewels.
CENTRE: a recessed octagonal plate, about 76% of the seal's width (as large as the plate of the attached octagon ring allows), of rich, saturated deep burgundy red enamel, glossy like fired enamel. Around the inside edge of the plate runs only a hairline enamel line of ivory white, no wider than 1.5% of the seal's width, bordered by a fine gold line. A barely visible tone-on-tone damask pattern on the plate, at most 10% lighter or darker than the base, and the middle three-quarters of the plate perfectly calm and empty, because a character portrait and a large number will be placed there later.

BACKGROUND AND OUTPUT: square 1:1, 1254 x 1254 or larger, seal centred and filling about 85% of the frame. Nothing outside the seal: no glow, no drop shadow, no reflection, no vignette, no ground. No text, letters, numbers, flag or watermark anywhere.
```

**Taiwan (Taipei)**
```
Create ONE ornate gold seal medallion for a luxury card game, on a pure black (#000000) background.

STYLE: match the attached round gold medallions: polished antique gold, fine filigree scrollwork, small faceted jewels, dark enamel centre, soft warm highlights, realistic metal. Copy their craftsmanship and lighting only, NOT their round shape.
SHAPE: copy the attached octagon ring's shape and proportions (ignore its green colour). A REGULAR OCTAGON, eight equal straight sides, one flat side on top, NOT round. The outer rim is solid and closed: no cut-outs, no pierced openwork, no gaps, with fine scrollwork in relief on it. THE RIM IS THIN AND NARROW: the whole gold border band is only about 6% of the seal's width on each side, so the centre plate takes up almost the entire seal.
TOP: a small eight-point star centred on the top of the rim, sitting within the thin rim.
CORNERS: one small faceted aquamarine at each of the four diagonal corners of the rim, all four identical, set in gold claws.
BOTTOM: centred on the lower rim, one small, compact gold relief emblem of Taipei 101, the tall tower built from eight stacked, flared sections: a simple, chunky silhouette that still reads when the whole seal is only 80 pixels wide. It sits on the thin lower rim and rises only slightly into the plate, no more than about 5% of the seal's height.
COLOUR: gold is the dominant colour of the whole seal. ALL metal is polished antique gold (rim, scrollwork, star, emblem, jewel claws); no silver, black or coloured metal. National colours appear ONLY in the enamel and the jewels.
CENTRE: a recessed octagonal plate, about 76% of the seal's width (as large as the plate of the attached octagon ring allows), of rich, saturated deep jade teal enamel, glossy like fired enamel. Around the inside edge of the plate runs only a hairline enamel line of white with a fine red line, no wider than 1.5% of the seal's width, bordered by a fine gold line. A barely visible tone-on-tone damask pattern on the plate, at most 10% lighter or darker than the base, and the middle three-quarters of the plate perfectly calm and empty, because a character portrait and a large number will be placed there later.

BACKGROUND AND OUTPUT: square 1:1, 1254 x 1254 or larger, seal centred and filling about 85% of the frame. Nothing outside the seal: no glow, no drop shadow, no reflection, no vignette, no ground. No text, letters, numbers, flag or watermark anywhere.
```

**China (Shanghai)**
```
Create ONE ornate gold seal medallion for a luxury card game, on a pure black (#000000) background.

STYLE: match the attached round gold medallions: polished antique gold, fine filigree scrollwork, small faceted jewels, dark enamel centre, soft warm highlights, realistic metal. Copy their craftsmanship and lighting only, NOT their round shape.
SHAPE: copy the attached octagon ring's shape and proportions (ignore its green colour). A REGULAR OCTAGON, eight equal straight sides, one flat side on top, NOT round. The outer rim is solid and closed: no cut-outs, no pierced openwork, no gaps, with fine scrollwork in relief on it. THE RIM IS THIN AND NARROW: the whole gold border band is only about 6% of the seal's width on each side, so the centre plate takes up almost the entire seal.
TOP: a small eight-point star centred on the top of the rim, sitting within the thin rim.
CORNERS: one small faceted jade at each of the four diagonal corners of the rim, all four identical, set in gold claws.
BOTTOM: centred on the lower rim, one small, compact gold relief emblem of a three-tier Chinese pagoda with upturned eaves: a simple, chunky silhouette that still reads when the whole seal is only 80 pixels wide. It sits on the thin lower rim and rises only slightly into the plate, no more than about 5% of the seal's height.
COLOUR: gold is the dominant colour of the whole seal. ALL metal is polished antique gold (rim, scrollwork, star, emblem, jewel claws); no silver, black or coloured metal. National colours appear ONLY in the enamel and the jewels.
CENTRE: a recessed octagonal plate, about 76% of the seal's width (as large as the plate of the attached octagon ring allows), of rich, saturated ink-black lacquer enamel, glossy like fired enamel. Around the inside edge of the plate runs only a hairline enamel line of imperial red, no wider than 1.5% of the seal's width, bordered by a fine gold line. A barely visible tone-on-tone damask pattern on the plate, at most 10% lighter or darker than the base, and the middle three-quarters of the plate perfectly calm and empty, because a character portrait and a large number will be placed there later.

BACKGROUND AND OUTPUT: square 1:1, 1254 x 1254 or larger, seal centred and filling about 85% of the frame. Nothing outside the seal: no glow, no drop shadow, no reflection, no vignette, no ground. No text, letters, numbers, flag or watermark anywhere.
```

**South Korea (Seoul)**
```
Create ONE ornate gold seal medallion for a luxury card game, on a pure black (#000000) background.

STYLE: match the attached round gold medallions: polished antique gold, fine filigree scrollwork, small faceted jewels, dark enamel centre, soft warm highlights, realistic metal. Copy their craftsmanship and lighting only, NOT their round shape.
SHAPE: copy the attached octagon ring's shape and proportions (ignore its green colour). A REGULAR OCTAGON, eight equal straight sides, one flat side on top, NOT round. The outer rim is solid and closed: no cut-outs, no pierced openwork, no gaps, with fine scrollwork in relief on it. THE RIM IS THIN AND NARROW: the whole gold border band is only about 6% of the seal's width on each side, so the centre plate takes up almost the entire seal.
TOP: a small eight-point star centred on the top of the rim, sitting within the thin rim.
CORNERS: one small faceted diamond at each of the four diagonal corners of the rim, all four identical, set in gold claws.
BOTTOM: centred on the lower rim, one small, compact gold relief emblem of a Korean palace gate with a curved, tiled roof: a simple, chunky silhouette that still reads when the whole seal is only 80 pixels wide. It sits on the thin lower rim and rises only slightly into the plate, no more than about 5% of the seal's height.
COLOUR: gold is the dominant colour of the whole seal. ALL metal is polished antique gold (rim, scrollwork, star, emblem, jewel claws); no silver, black or coloured metal. National colours appear ONLY in the enamel and the jewels.
CENTRE: a recessed octagonal plate, about 76% of the seal's width (as large as the plate of the attached octagon ring allows), of rich, saturated celadon green enamel, glossy like fired enamel. Around the inside edge of the plate runs only a hairline enamel line of white with a fine blue line, no wider than 1.5% of the seal's width, bordered by a fine gold line. A barely visible tone-on-tone damask pattern on the plate, at most 10% lighter or darker than the base, and the middle three-quarters of the plate perfectly calm and empty, because a character portrait and a large number will be placed there later.

BACKGROUND AND OUTPUT: square 1:1, 1254 x 1254 or larger, seal centred and filling about 85% of the frame. Nothing outside the seal: no glow, no drop shadow, no reflection, no vignette, no ground. No text, letters, numbers, flag or watermark anywhere.
```

**Japan (Tokyo)**
```
Create ONE ornate gold seal medallion for a luxury card game, on a pure black (#000000) background.

STYLE: match the attached round gold medallions: polished antique gold, fine filigree scrollwork, small faceted jewels, dark enamel centre, soft warm highlights, realistic metal. Copy their craftsmanship and lighting only, NOT their round shape.
SHAPE: copy the attached octagon ring's shape and proportions (ignore its green colour). A REGULAR OCTAGON, eight equal straight sides, one flat side on top, NOT round. The outer rim is solid and closed: no cut-outs, no pierced openwork, no gaps, with fine scrollwork in relief on it. THE RIM IS THIN AND NARROW: the whole gold border band is only about 6% of the seal's width on each side, so the centre plate takes up almost the entire seal.
TOP: a small eight-point star centred on the top of the rim, sitting within the thin rim.
CORNERS: one small faceted pink sapphire at each of the four diagonal corners of the rim, all four identical, set in gold claws.
BOTTOM: centred on the lower rim, one small, compact gold relief emblem of a cherry blossom (sakura) tree in bloom, with a bent trunk and a rounded crown of blossom: a simple, chunky silhouette that still reads when the whole seal is only 80 pixels wide. It sits on the thin lower rim and rises only slightly into the plate, no more than about 5% of the seal's height.
COLOUR: gold is the dominant colour of the whole seal. ALL metal is polished antique gold (rim, scrollwork, star, emblem, jewel claws); no silver, black or coloured metal. National colours appear ONLY in the enamel and the jewels.
CENTRE: a recessed octagonal plate, about 76% of the seal's width (as large as the plate of the attached octagon ring allows), of rich, saturated deep sakura rose pink enamel, glossy like fired enamel. Around the inside edge of the plate runs only a hairline enamel line of ivory white with a fine red line, no wider than 1.5% of the seal's width, bordered by a fine gold line. A barely visible tone-on-tone damask pattern on the plate, at most 10% lighter or darker than the base, and the middle three-quarters of the plate perfectly calm and empty, because a character portrait and a large number will be placed there later.

BACKGROUND AND OUTPUT: square 1:1, 1254 x 1254 or larger, seal centred and filling about 85% of the frame. Nothing outside the seal: no glow, no drop shadow, no reflection, no vignette, no ground. No text, letters, numbers, flag or watermark anywhere.
```

### Filled Step B prompts (paste one per country)

**Saudi Arabia (Riyadh)**
```
Attached is the approved seal. Make the identical seal for SAUDI ARABIA. Keep its thin rim and its large plate (about 76% of the seal's width) exactly. Change ONLY four things: the enamel plate colour to emerald green, the hairline inner line to ivory white, the four small corner jewels to emerald, and the small bottom emblem to a date palm tree above two crossed curved swords. The rim, scrollwork, star, octagon proportions, lighting, size, position and the pure black background must stay exactly the same. All metal stays polished gold and gold stays the dominant colour: the national colours appear only in the enamel and the jewels. Same rules: solid closed outer rim, calm empty centre, no text, letters, numbers or flag, no glow or shadow.
```

**India (Mumbai)**
```
Attached is the approved seal. Make the identical seal for INDIA. Keep its thin rim and its large plate (about 76% of the seal's width) exactly. Change ONLY four things: the enamel plate colour to deep saffron orange, the hairline inner line to emerald green with a fine white line, the four small corner jewels to citrine, and the small bottom emblem to the Taj Mahal, with a central onion dome flanked by four slender minarets. The rim, scrollwork, star, octagon proportions, lighting, size, position and the pure black background must stay exactly the same. All metal stays polished gold and gold stays the dominant colour: the national colours appear only in the enamel and the jewels. Same rules: solid closed outer rim, calm empty centre, no text, letters, numbers or flag, no glow or shadow.
```

**Thailand (Bangkok)**
```
Attached is the approved seal. Make the identical seal for THAILAND. Keep its thin rim and its large plate (about 76% of the seal's width) exactly. Change ONLY four things: the enamel plate colour to deep royal blue, the hairline inner line to red with a fine white line, the four small corner jewels to sapphire, and the small bottom emblem to an elephant seen from the side with its trunk raised. The rim, scrollwork, star, octagon proportions, lighting, size, position and the pure black background must stay exactly the same. All metal stays polished gold and gold stays the dominant colour: the national colours appear only in the enamel and the jewels. Same rules: solid closed outer rim, calm empty centre, no text, letters, numbers or flag, no glow or shadow.
```

**Vietnam (Ho Chi Minh City)**
```
Attached is the approved seal. Make the identical seal for VIETNAM. Keep its thin rim and its large plate (about 76% of the seal's width) exactly. Change ONLY four things: the enamel plate colour to bright lacquer red, the hairline inner line to golden yellow, the four small corner jewels to ruby, and the small bottom emblem to a single lotus flower in bloom. The rim, scrollwork, star, octagon proportions, lighting, size, position and the pure black background must stay exactly the same. All metal stays polished gold and gold stays the dominant colour: the national colours appear only in the enamel and the jewels. Same rules: solid closed outer rim, calm empty centre, no text, letters, numbers or flag, no glow or shadow.
```

**Philippines (Manila)**
```
Attached is the approved seal. Make the identical seal for THE PHILIPPINES. Keep its thin rim and its large plate (about 76% of the seal's width) exactly. Change ONLY four things: the enamel plate colour to bright turquoise sea blue, the hairline inner line to golden yellow, the four small corner jewels to pearl, and the small bottom emblem to a jeepney, the long Filipino jeep-bus, in side view with its long bonnet and curved roof. The rim, scrollwork, star, octagon proportions, lighting, size, position and the pure black background must stay exactly the same. All metal stays polished gold and gold stays the dominant colour: the national colours appear only in the enamel and the jewels. Same rules: solid closed outer rim, calm empty centre, no text, letters, numbers or flag, no glow or shadow.
```

**Indonesia (Jakarta)**
```
Attached is the approved seal. Make the identical seal for INDONESIA. Keep its thin rim and its large plate (about 76% of the seal's width) exactly. Change ONLY four things: the enamel plate colour to deep burgundy red, the hairline inner line to ivory white, the four small corner jewels to garnet, and the small bottom emblem to Borobudur, a stepped temple mound crowned by a bell-shaped stupa. The rim, scrollwork, star, octagon proportions, lighting, size, position and the pure black background must stay exactly the same. All metal stays polished gold and gold stays the dominant colour: the national colours appear only in the enamel and the jewels. Same rules: solid closed outer rim, calm empty centre, no text, letters, numbers or flag, no glow or shadow.
```

**Taiwan (Taipei)**
```
Attached is the approved seal. Make the identical seal for TAIWAN. Keep its thin rim and its large plate (about 76% of the seal's width) exactly. Change ONLY four things: the enamel plate colour to deep jade teal, the hairline inner line to white with a fine red line, the four small corner jewels to aquamarine, and the small bottom emblem to Taipei 101, the tall tower built from eight stacked, flared sections. The rim, scrollwork, star, octagon proportions, lighting, size, position and the pure black background must stay exactly the same. All metal stays polished gold and gold stays the dominant colour: the national colours appear only in the enamel and the jewels. Same rules: solid closed outer rim, calm empty centre, no text, letters, numbers or flag, no glow or shadow.
```

**China (Shanghai)**
```
Attached is the approved seal. Make the identical seal for CHINA. Keep its thin rim and its large plate (about 76% of the seal's width) exactly. Change ONLY four things: the enamel plate colour to ink-black lacquer, the hairline inner line to imperial red, the four small corner jewels to jade, and the small bottom emblem to a three-tier Chinese pagoda with upturned eaves. The rim, scrollwork, star, octagon proportions, lighting, size, position and the pure black background must stay exactly the same. All metal stays polished gold and gold stays the dominant colour: the national colours appear only in the enamel and the jewels. Same rules: solid closed outer rim, calm empty centre, no text, letters, numbers or flag, no glow or shadow.
```

**South Korea (Seoul)**
```
Attached is the approved seal. Make the identical seal for SOUTH KOREA. Keep its thin rim and its large plate (about 76% of the seal's width) exactly. Change ONLY four things: the enamel plate colour to celadon green, the hairline inner line to white with a fine blue line, the four small corner jewels to diamond, and the small bottom emblem to a Korean palace gate with a curved, tiled roof. The rim, scrollwork, star, octagon proportions, lighting, size, position and the pure black background must stay exactly the same. All metal stays polished gold and gold stays the dominant colour: the national colours appear only in the enamel and the jewels. Same rules: solid closed outer rim, calm empty centre, no text, letters, numbers or flag, no glow or shadow.
```

**Japan (Tokyo)**
```
Attached is the approved seal. Make the identical seal for JAPAN. Keep its thin rim and its large plate (about 76% of the seal's width) exactly. Change ONLY four things: the enamel plate colour to deep sakura rose pink, the hairline inner line to ivory white with a fine red line, the four small corner jewels to pink sapphire, and the small bottom emblem to a cherry blossom (sakura) tree in bloom, with a bent trunk and a rounded crown of blossom. The rim, scrollwork, star, octagon proportions, lighting, size, position and the pure black background must stay exactly the same. All metal stays polished gold and gold stays the dominant colour: the national colours appear only in the enamel and the jewels. Same rules: solid closed outer rim, calm empty centre, no text, letters, numbers or flag, no glow or shadow.
```

Save as `afbeeldingen/World Tour/Asia/Gold medaillons/<country> gold.png` (for example `japan gold.png`, like Europe's `Italy gold.png`), full size. Then tell me: I cut the black background out, build each champion's seal ring from it, and size the seals for the map.

## Worked example: Italy (Step A, the master)
```
Create ONE ornate gold seal medallion for a luxury card game, on a pure black (#000000) background.

STYLE: match the attached round gold medallions: polished antique gold, fine filigree scrollwork, small faceted jewels, dark enamel centre, soft warm highlights, realistic metal. Copy their craftsmanship and lighting only, NOT their round shape.
SHAPE: copy the attached octagon ring's shape and proportions (ignore its green colour). A REGULAR OCTAGON, eight equal straight sides, one flat side on top, NOT round. The outer rim is solid and closed: no cut-outs, no pierced openwork, no gaps, with fine scrollwork in relief on it.
TOP: a small eight-point star centred on the top of the rim.
CORNERS: one faceted ruby at each of the four diagonal corners of the rim, all four identical, set in gold claws.
BOTTOM: centred on the lower rim, one bold gold relief emblem of the two-tier arcade of the Colosseum: a simple, chunky silhouette that still reads when the whole seal is only 80 pixels wide.
COLOUR: gold is the dominant colour of the whole seal. ALL metal is polished antique gold (rim, scrollwork, star, emblem, jewel claws); no silver, black or coloured metal. National colours appear ONLY in the enamel and the jewels.
CENTRE: a recessed octagonal plate, about 60% of the seal's width, of rich, saturated emerald green enamel, glossy like fired enamel. Around the inside edge of the plate runs a thin enamel band of ivory white with a fine red line, bordered in gold. A barely visible tone-on-tone damask pattern on the plate, at most 10% lighter or darker than the base, and the middle two-thirds of the plate perfectly calm and empty, because a large number will be placed there later.

BACKGROUND AND OUTPUT: square 1:1, 1254 x 1254 or larger, seal centred and filling about 85% of the frame. Nothing outside the seal: no glow, no drop shadow, no reflection, no vignette, no ground. No text, letters, numbers, flag or watermark anywhere.
```

## Later continents
Same two steps with a new row per country: the colours the country is known for (main colour on the plate, second colour as the band and gems), and one bold landmark or heraldic motif. If two countries on one continent share colours, separate them by band, gem and emblem, and note it in an "overlaps" line like the one above. 60 seals in total, 10 per continent.

## Checks before keeping one
1. Regular octagon, flat side on top, eight equal straight sides, same family as the attached medallions. If it comes back round, say "regular octagon, eight straight sides, NOT round".
2. Outer rim solid and closed, no gaps (needed for the black cut-out).
3. Four corner gems identical; star on top; one emblem at the bottom.
4. Gold is clearly the main colour (all metal gold, no silver or coloured metal); the national colours sit only in the plate, the band and the gems. Plate about 60% of the width, middle two-thirds calm and empty.
5. No text, letters, numbers or flags anywhere; pure black background, nothing outside the seal.
6. The emblem still reads when the picture is shrunk to about 80 pixels.

## Save as
`afbeeldingen/World Tour/Seals/<country>.png` (for example `italy.png`), full size. Then tell me: I cut out the black background, test the number on it at about 90px and size them like the old gold medallions.

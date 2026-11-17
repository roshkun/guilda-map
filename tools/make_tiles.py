#!/usr/bin/env python3
"""Gera a pirâmide de tiles (256px) de uma imagem grande para o Leaflet.

Uso:  python3 tools/make_tiles.py CAMINHO_DA_IMAGEM [saida=assets/tiles] [formato=webp] [qualidade=80]

Imprime width/height e o maior nível de zoom (maxNativeZoom) para colocar em data/config.json.
Requer Pillow (pip install pillow).
"""
import math, os, sys
from PIL import Image
Image.MAX_IMAGE_PIXELS = None

src = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else "assets/tiles"
fmt = (sys.argv[3] if len(sys.argv) > 3 else "webp").lower()
quality = int(sys.argv[4]) if len(sys.argv) > 4 else 80
T = 256

img = Image.open(src).convert("RGB")
W, H = img.size
nz = max(0, math.ceil(math.log2(max(W, H) / T)))      # maior zoom nativo
full = T * 2 ** nz                                       # lado do nível mais alto
canvas = Image.new("RGB", (full, full), (0, 0, 0))      # imagem ancorada no canto superior esquerdo
canvas.paste(img, (0, 0)); del img

total = 0
for z in range(nz, -1, -1):
    side = T * 2 ** z
    level = canvas if side == full else canvas.resize((side, side), Image.LANCZOS)
    n = 2 ** z
    for x in range(n):
        for y in range(n):
            box = (x * T, y * T, (x + 1) * T, (y + 1) * T)
            # pula tiles totalmente fora da imagem original
            if box[0] >= W * side / full or box[1] >= H * side / full:
                continue
            d = os.path.join(out, str(z), str(x)); os.makedirs(d, exist_ok=True)
            kw = {"quality": quality, "method": 6} if fmt == "webp" else {"quality": quality, "optimize": True}
            level.crop(box).save(os.path.join(d, f"{y}.{fmt}"), **kw); total += 1
    print(f"zoom {z}: {n*n} tiles", flush=True)
print(f"\nwidth={W} height={H} maxNativeZoom={nz} tiles={total}")

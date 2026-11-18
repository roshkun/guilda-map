#!/usr/bin/env python3
"""Gera data/network.json (rede de estradas, trilhas e Ferroáurea) a partir da imagem do mapa.

Uso:  python3 tools/build_network.py CAMINHO_DA_IMAGEM [--km-per-px 0.4795] [--debug pasta]

Requer: numpy, scipy, scikit-image, opencv-python e Pillow.
Entradas:  data/markers.json, tools/train_chains.json, tools/extra_links.json
Saída:     data/network.json
"""
import argparse, json, math, os, sys, time, unicodedata
import numpy as np
import cv2
from PIL import Image, ImageDraw
from skimage.graph import route_through_array

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from netgraph import (skeleton_from_mask, trace_graph, collapse_deg2, prune_spurs, drop_small_components,
                      bridge_gaps, attach_points, simplify, seg_len, Graph)

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def norm(s):
    return unicodedata.normalize('NFD', s).encode('ascii', 'ignore').decode().lower().strip()


def road_graph(im):
    R = im[..., 0].astype(np.int16); G = im[..., 1].astype(np.int16); B = im[..., 2].astype(np.int16)
    red = (R > 42) & ((R - np.maximum(G, B)) * 2 >= R)            # vermelho (estradas, túneis e trilhas)
    sk = skeleton_from_mask(red, close=9, min_area=6)
    g = trace_graph(sk)
    collapse_deg2(g); prune_spurs(g, min_len=25); drop_small_components(g, 40)
    bridge_gaps(g, radius=80); collapse_deg2(g)
    # estrada x trilha: trilha = linha feita de pontos pequenos isolados
    red8 = red.astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(red8, connectivity=8)
    area = st[:, cv2.CC_STAT_AREA].astype(np.int32)
    lab_d = cv2.dilate(lab.astype(np.float32), np.ones((3, 3), np.uint8)).astype(np.int32)
    for d in g.edges.values():
        p = np.array(d['path']); L = lab_d[p[:, 1], p[:, 0]]; L = L[L > 0]
        d['kind'] = 1 if (len(L) >= 4 and (area[L] < 40).mean() > 0.6) else 0
    return g


def train_cost(im):
    R = im[..., 0].astype(np.int16); G = im[..., 1].astype(np.int16); B = im[..., 2].astype(np.int16)
    mn = np.minimum(np.minimum(R, G), B); mx = np.maximum(np.maximum(R, G), B)
    lum = (R + G + B) // 3
    white = (mn > 175) & ((mx - mn) < 45)
    neardark = cv2.dilate((lum < 50).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))) > 0
    m = (white & ~neardark).astype(np.uint8)
    nlab, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    big = np.where(st[:, cv2.CC_STAT_AREA] > 350)[0]; big = big[big != 0]
    m[np.isin(lab, big)] = 0
    dt = cv2.distanceTransform((1 - m).astype(np.uint8), cv2.DIST_L2, 3)
    return (1.0 + np.minimum((dt / 3.0) ** 2, 300.0)).astype(np.float32)


def train_graph(cost, chains, markers):
    by_name = {norm(m['name']): m for m in markers}
    g = Graph(); station_node = {}
    H, W = cost.shape

    def resolve(item):
        if isinstance(item, str):
            m = by_name.get(norm(item))
            if not m:
                raise SystemExit(f'Marcador não encontrado na cadeia do trem: {item}')
            return (m['x'], m['y']), m['id']
        return (int(item[0]), int(item[1])), None

    def node_for(pt, mid):
        if mid and mid in station_node:
            return station_node[mid]
        n = g.add_node(*pt)
        if mid:
            station_node[mid] = n
        return n

    for chain in chains:
        items = [resolve(i) for i in chain]
        for (p0, m0), (p1, m1) in zip(items[:-1], items[1:]):
            x0, y0 = p0; x1, y1 = p1
            mg = 220
            bx0, by0 = max(0, min(x0, x1) - mg), max(0, min(y0, y1) - mg)
            bx1, by1 = min(W, max(x0, x1) + mg), min(H, max(y0, y1) + mg)
            sub = cost[by0:by1, bx0:bx1]
            path, _ = route_through_array(sub, (y0 - by0, x0 - bx0), (y1 - by0, x1 - bx0),
                                          fully_connected=True, geometric=True)
            pts = [(int(c + bx0), int(r + by0)) for r, c in path]
            a = node_for(p0, m0); b = node_for(p1, m1)
            g.add_edge(a, b, pts, 2)
    return g, station_node


def export_graph(g, point_nodes, extra=None):
    ids = {n: i for i, n in enumerate(g.nodes)}
    nodes = [list(g.nodes[n]) for n in g.nodes]
    edges = []
    for d in g.edges.values():
        pp = simplify(d['path'], 1.5)
        flat = [int(v) for p in pp for v in p]
        edges.append([ids[d['a']], ids[d['b']], round(seg_len(d['path']), 1), d['kind'], flat])
    out = {'nodes': nodes, 'edges': edges, 'points': {k: ids[v] for k, v in point_nodes.items() if v in ids}}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('image')
    ap.add_argument('--km-per-px', type=float, default=0.4795)
    ap.add_argument('--debug')
    ap.add_argument('--station-px', type=float, default=60, help='raio (px) para criar estação em cidades/vilas perto da linha')
    a = ap.parse_args()
    t0 = time.time()
    im = np.array(Image.open(a.image).convert('RGB'))
    markers = json.load(open(os.path.join(ROOT, 'data/markers.json'), encoding='utf-8'))
    chains = json.load(open(os.path.join(ROOT, 'tools/train_chains.json'), encoding='utf-8'))['chains']
    extra = json.load(open(os.path.join(ROOT, 'tools/extra_links.json'), encoding='utf-8')).get('links', [])

    print('estradas e trilhas...', flush=True)
    g = road_graph(im)
    pts = {m['id']: (m['x'], m['y']) for m in markers}
    for i, L in enumerate(extra):
        pts[f'__x{i}a'] = tuple(L['a']); pts[f'__x{i}b'] = tuple(L['b'])
    nodes, offs = attach_points(g, pts, snap=80, hub=40)
    for i, L in enumerate(extra):
        na, nb = nodes.get(f'__x{i}a'), nodes.get(f'__x{i}b')
        if na and nb:
            g.add_edge(na, nb, [tuple(L['a']), tuple(L['b'])], L.get('kind', 1))
    pnodes = {k: v for k, v in nodes.items() if not k.startswith('__x')}

    print('ferroáurea...', flush=True)
    cost = train_cost(im)
    tg, stn = train_graph(cost, chains, markers)
    # estações extras: cidades/vilas a até 35 px do trajeto
    from scipy.spatial import cKDTree
    tp = np.array([p for d in tg.edges.values() for p in d['path']], dtype=np.float64)
    tree = cKDTree(tp)
    for m in markers:
        if m['category'] in ('capital', 'city', 'town') and m['id'] not in stn:
            if tree.query([m['x'], m['y']])[0] <= a.station_px:
                stn[m['id']] = None
    # estações sem nó próprio: encaixa no trajeto
    missing = {k: (pts[k]) for k, v in stn.items() if v is None}
    if missing:
        tn, _ = attach_points(tg, missing, snap=60, hub=0)
        stn.update(tn)
    stn = {k: v for k, v in stn.items() if v}

    net = {
        'kmPerPx': a.km_per_px,
        'ground': export_graph(g, pnodes),
        'train': export_graph(tg, stn),
        'notConnected': sorted(k for k in pts if not k.startswith('__x') and k not in pnodes),
    }
    out = os.path.join(ROOT, 'data/network.json')
    json.dump(net, open(out, 'w'), separators=(',', ':'))
    print(f"ok: {len(net['ground']['nodes'])} nós, {len(net['ground']['edges'])} trechos de terra; "
          f"trem: {len(net['train']['edges'])} trechos, {len(net['train']['points'])} estações; "
          f"{os.path.getsize(out)//1024} KB; {time.time()-t0:.0f}s")
    if a.debug:
        os.makedirs(a.debug, exist_ok=True)
        img = Image.fromarray(im); dr = ImageDraw.Draw(img)
        col = {0: (0, 255, 255), 1: (255, 255, 0)}
        for e in net['ground']['edges']:
            dr.line([tuple(e[4][i:i + 2]) for i in range(0, len(e[4]), 2)], fill=col[e[3]], width=7)
        for e in net['train']['edges']:
            dr.line([tuple(e[4][i:i + 2]) for i in range(0, len(e[4]), 2)], fill=(255, 0, 255), width=9)
        for k in net['train']['points']:
            x, y = pts[k]; dr.ellipse((x - 20, y - 20, x + 20, y + 20), outline=(0, 255, 0), width=8)
        img.save(os.path.join(a.debug, 'rede.png'))


if __name__ == '__main__':
    main()

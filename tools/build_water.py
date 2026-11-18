#!/usr/bin/env python3
"""Gera data/water.json: rotas SIMULADAS de barco pequeno (costa + rios) e navio grande (mar aberto).

Uso:  python3 tools/build_water.py CAMINHO_DA_IMAGEM [--km-per-px 0.4795] [--debug pasta]

Método
  1. Máscara do mar por cor; oceano = componentes grandes. Resolução de trabalho = imagem / 4.
  2. Portos = vilas/cidades/capitais/fortes a até PORT_MAX px da costa; o ponto de embarque é o pixel de oceano mais próximo.
  3. Rotas por menor custo (skimage MCP): barco pequeno só navega numa faixa estreita junto à costa;
     navio grande navega em mar aberto evitando águas rasas. Cada porto liga aos K portos mais próximos (por custo).
  4. Rios = linhas azul-acinzentadas em terra → esqueleto → grafo. Sentido da correnteza: rumo à foz (ligada ao mar).
     Rios sem foz alcançável ficam sem sentido (correnteza 0).
  5. Relatório: lugares costeiros sem rota marítima, ilhas/baías isoladas, rios sem foz.
"""
import argparse, json, math, os, sys, time, heapq
import numpy as np
import cv2
from PIL import Image
from scipy import ndimage as ndi
from skimage.graph import MCP_Geometric

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from netgraph import (skeleton_from_mask, trace_graph, collapse_deg2, prune_spurs, drop_small_components,
                      bridge_gaps, attach_points, simplify, seg_len)

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
F = 4                                  # fator de redução
PORT_MAX = 70                          # px da imagem original
SMALL_CATS = ('capital', 'city', 'town', 'fort')
LARGE_CATS = ('capital', 'city')
BAND_SMALL = 30                        # px (já reduzido) de faixa costeira p/ barco pequeno (~58 km)
SHALLOW_LARGE = 5                      # px reduzido de águas rasas penalizadas p/ navio
RIVER_SNAP = 30                        # px: cidade a até isso do rio vira porto fluvial
K_SMALL, K_LARGE = 7, 6


def ocean_mask(im):
    R = im[..., 0].astype(np.int16); G = im[..., 1].astype(np.int16); B = im[..., 2].astype(np.int16)
    sea = (R < 80) & (G - R > 30) & (B - R > 30)
    sea_s = cv2.resize(sea.astype(np.float32), (im.shape[1] // F, im.shape[0] // F), interpolation=cv2.INTER_AREA) > 0.5
    lab, n = ndi.label(sea_s)
    sz = ndi.sum(sea_s, lab, range(1, n + 1))
    keep = [i + 1 for i, s in enumerate(sz) if s > 400]
    ocean = np.isin(lab, keep)
    # remove "ilhotas" falsas (texto sobre o mar) e fecha buracos pequenos
    land = ~ocean
    lab2, n2 = ndi.label(land)
    sz2 = ndi.sum(land, lab2, range(1, n2 + 1))
    tiny = [i + 1 for i, s in enumerate(sz2) if s < 25]
    ocean |= np.isin(lab2, tiny)
    return ocean, sea


def river_mask(im, ocean_full_near):
    R = im[..., 0].astype(np.int16); G = im[..., 1].astype(np.int16); B = im[..., 2].astype(np.int16)
    riv = (R >= 65) & (R <= 125) & (G - R >= 22) & (G - R <= 70) & (B - R >= 10) & (B - R <= 60) & (np.abs(G - B) <= 25)
    riv &= ~ocean_full_near
    n, lab, st, _ = cv2.connectedComponentsWithStats(riv.astype(np.uint8), connectivity=8)
    small = np.where(st[:, cv2.CC_STAT_AREA] < 60)[0]
    riv[np.isin(lab, small)] = False
    return riv


def path_len(pts):
    return float(sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1)))


def sea_network(cost, nodes, k, label):
    """nodes: lista de (x,y) em coords reduzidas. Retorna arestas [(i,j,pts_orig)], componentes."""
    n = len(nodes); edges = {}
    t0 = time.time()
    for i, (x, y) in enumerate(nodes):
        m = MCP_Geometric(cost, fully_connected=True)
        cum, _ = m.find_costs([(y, x)])
        cs = [(cum[ny, nx], j) for j, (nx, ny) in enumerate(nodes) if j != i and np.isfinite(cum[ny, nx])]
        cs.sort()
        for c, j in cs[:k]:
            key = (min(i, j), max(i, j))
            if key in edges:
                continue
            tb = m.traceback((nodes[j][1], nodes[j][0]))
            edges[key] = [(px * F + F // 2, py * F + F // 2) for py, px in tb] if key[0] == i else \
                         [(px * F + F // 2, py * F + F // 2) for py, px in tb][::-1]
        if (i + 1) % 10 == 0:
            print(f'  {label}: {i+1}/{n} ({time.time()-t0:.0f}s)', flush=True)
    return edges


def components(n, edges):
    p = list(range(n))
    def f(a):
        while p[a] != a:
            p[a] = p[p[a]]; a = p[a]
        return a
    for a, b in edges:
        p[f(a)] = f(b)
    return [f(i) for i in range(n)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('image'); ap.add_argument('--km-per-px', type=float, default=0.4795); ap.add_argument('--debug')
    a = ap.parse_args(); kmpx = a.km_per_px
    t0 = time.time()
    im = np.array(Image.open(a.image).convert('RGB'))
    markers = json.load(open(os.path.join(ROOT, 'data/markers.json'), encoding='utf-8'))
    mid = {m['id']: m for m in markers}

    print('mar...', flush=True)
    ocean, sea_full = ocean_mask(im)
    distL = ndi.distance_transform_edt(ocean).astype(np.float32)          # oceano -> terra
    dist_to_ocean, (iy, ix) = ndi.distance_transform_edt(~ocean, return_indices=True)

    def port_pixel(m):
        x, y = m['x'] // F, m['y'] // F
        x = min(max(x, 0), ocean.shape[1] - 1); y = min(max(y, 0), ocean.shape[0] - 1)
        d = dist_to_ocean[y, x] * F
        return (int(ix[y, x]), int(iy[y, x])), float(d)

    # portos
    ports = {}
    report = {'noSeaRoute': [], 'farFromSea': []}
    for m in markers:
        if m['category'] not in SMALL_CATS:
            continue
        p, d = port_pixel(m)
        if d <= PORT_MAX:
            ports[m['id']] = (p, d)
        elif d <= PORT_MAX * 2:
            report['farFromSea'].append(m['name'])
    print(len(ports), 'portos candidatos', flush=True)

    # ---- rios ----
    print('rios...', flush=True)
    near_sea = cv2.dilate(cv2.resize(ocean.astype(np.uint8), (im.shape[1], im.shape[0]), interpolation=cv2.INTER_NEAREST),
                          np.ones((9, 9), np.uint8)) > 0
    riv = river_mask(im, near_sea)
    sk = skeleton_from_mask(riv, close=5, min_area=20)
    rg = trace_graph(sk)
    collapse_deg2(rg); prune_spurs(rg, min_len=40); drop_small_components(rg, 150)
    bridge_gaps(rg, radius=60); collapse_deg2(rg)
    settle = {m['id']: (m['x'], m['y']) for m in markers if m['category'] in SMALL_CATS}
    rn, _ = attach_points(rg, settle, snap=RIVER_SNAP, hub=0)
    rn = {k: v for k, v in rn.items() if v}
    rid = {n: i for i, n in enumerate(rg.nodes)}
    rnodes = [list(rg.nodes[n]) for n in rg.nodes]
    redges = []
    for d in rg.edges.values():
        pp = simplify(d['path'], 1.5)
        redges.append([rid[d['a']], rid[d['b']], round(seg_len(d['path']), 1), 0, [int(v) for p in pp for v in p], 0])
    print(f'  rios: {len(rnodes)} nós, {len(redges)} trechos, {len(rn)} cidades ribeirinhas', flush=True)

    # componentes do rio e foz
    rc = components(len(rnodes), [(e[0], e[1]) for e in redges])
    best = {}
    for i, (x, y) in enumerate(rnodes):
        d = dist_to_ocean[min(y // F, ocean.shape[0] - 1), min(x // F, ocean.shape[1] - 1)] * F
        if d <= 80 and (rc[i] not in best or d < best[rc[i]][0]):
            best[rc[i]] = (d, i)
    mouths = {}                                     # nó do rio -> pixel de oceano (reduzido)
    for comp, (d, i) in best.items():
        x, y = rnodes[i]; fx, fy = min(x // F, ocean.shape[1] - 1), min(y // F, ocean.shape[0] - 1)
        mouths[i] = (int(ix[fy, fx]), int(iy[fy, fx]))
    # sentido da correnteza: Dijkstra a partir das fozes
    adjr = [[] for _ in rnodes]
    for ei, e in enumerate(redges):
        adjr[e[0]].append((e[1], e[2])); adjr[e[1]].append((e[0], e[2]))
    dd = [math.inf] * len(rnodes); pq = []
    for i in mouths:
        dd[i] = 0; heapq.heappush(pq, (0, i))
    while pq:
        d, u = heapq.heappop(pq)
        if d > dd[u]:
            continue
        for v, w in adjr[u]:
            if d + w < dd[v]:
                dd[v] = d + w; heapq.heappush(pq, (d + w, v))
    for e in redges:
        da, db = dd[e[0]], dd[e[1]]
        if math.isinf(da) or math.isinf(db) or da == db:
            e[5] = 0
        else:
            e[5] = 1 if da > db else -1               # 1 = corre de a para b (descida), -1 = de b para a
    no_mouth = sorted({k for k, v in rn.items() if math.isinf(dd[rid[v]])})
    report['riverNoMouth'] = [mid[k]['name'] for k in no_mouth]

    # ---- rede do barco pequeno: portos + fozes ----
    cost_s = np.full(ocean.shape, np.inf, np.float32)
    ok = ocean & (distL <= BAND_SMALL)
    cost_s[ok] = 1.0 + 3.0 * (distL[ok] / BAND_SMALL) ** 2
    cost_l = np.full(ocean.shape, np.inf, np.float32)
    cost_l[ocean] = 1.0 + 8.0 * np.clip(1 - distL[ocean] / SHALLOW_LARGE, 0, 1) ** 2

    small_ids = list(ports)
    s_nodes = [ports[k][0] for k in small_ids] + [mouths[i] for i in mouths]
    s_kind = [('port', k) for k in small_ids] + [('mouth', i) for i in mouths]
    print('barcos pequenos...', flush=True)
    s_edges = sea_network(cost_s, s_nodes, K_SMALL, 'pequeno')

    large_ids = [k for k in ports if mid[k]['category'] in LARGE_CATS]
    l_nodes = [ports[k][0] for k in large_ids]
    print('navios grandes...', flush=True)
    l_edges = sea_network(cost_l, l_nodes, K_LARGE, 'grande')

    # conectividade
    def conn(n, edges):
        return components(n, list(edges.keys()))
    cs = conn(len(s_nodes), s_edges); cl = conn(len(l_nodes), l_edges)
    from collections import Counter
    main_s = Counter(cs).most_common(1)[0][0]; main_l = Counter(cl).most_common(1)[0][0]
    report['smallBoatIsolated'] = [mid[small_ids[i]]['name'] for i in range(len(small_ids)) if cs[i] != main_s]
    report['largeShipIsolated'] = [mid[large_ids[i]]['name'] for i in range(len(large_ids)) if cl[i] != main_l]
    report['smallBoatComponents'] = len(set(cs)); report['largeShipComponents'] = len(set(cl))
    report['ports'] = {'small': len(small_ids), 'large': len(large_ids), 'mouths': len(mouths)}
    report['noSeaRoute'] = sorted(set(report['smallBoatIsolated']) | set(report['largeShipIsolated']))

    # ---- exporta: boat (rio + mar pequeno) e ship ----
    boat_nodes = [list(n) for n in rnodes]
    boat_edges = [list(e) for e in redges]
    sea_idx = {}
    for i, (kind, ref) in enumerate(s_kind):
        if kind == 'mouth':
            x, y = s_nodes[i]
            sea_idx[i] = len(boat_nodes); boat_nodes.append([x * F + F // 2, y * F + F // 2])
            rx, ry = rnodes[ref]
            gap = math.hypot(rx - boat_nodes[-1][0], ry - boat_nodes[-1][1])
            boat_edges.append([ref, sea_idx[i], round(gap, 1), 3, [rx, ry, boat_nodes[-1][0], boat_nodes[-1][1]], 1])
        else:
            sea_idx[i] = len(boat_nodes); boat_nodes.append([s_nodes[i][0] * F + F // 2, s_nodes[i][1] * F + F // 2])
    for (i, j), pts in s_edges.items():
        pp = [tuple(p) for p in cv2.approxPolyDP(np.array(pts, np.int32).reshape(-1, 1, 2), 3, False).reshape(-1, 2)]
        boat_edges.append([sea_idx[i], sea_idx[j], round(path_len(pts), 1), 1, [int(v) for p in pp for v in p], 0])
    boat_points = {}
    for i, (kind, ref) in enumerate(s_kind):
        if kind == 'port':
            boat_points.setdefault(ref, []).append(sea_idx[i])
    for k, v in rn.items():
        boat_points.setdefault(k, []).append(rid[v])

    ship_nodes = [[x * F + F // 2, y * F + F // 2] for x, y in l_nodes]
    ship_edges = []
    for (i, j), pts in l_edges.items():
        pp = [tuple(p) for p in cv2.approxPolyDP(np.array(pts, np.int32).reshape(-1, 1, 2), 3, False).reshape(-1, 2)]
        ship_edges.append([i, j, round(path_len(pts), 1), 2, [int(v) for p in pp for v in p], 0])
    ship_points = {k: [i] for i, k in enumerate(large_ids)}

    out = {'kmPerPx': kmpx,
           'boat': {'nodes': boat_nodes, 'edges': boat_edges, 'points': boat_points},
           'ship': {'nodes': ship_nodes, 'edges': ship_edges, 'points': ship_points},
           'report': report}
    path = os.path.join(ROOT, 'data/water.json')
    json.dump(out, open(path, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
    print(json.dumps(report, ensure_ascii=False, indent=1))
    print(f'ok: {os.path.getsize(path)//1024} KB; {time.time()-t0:.0f}s')

    if a.debug:
        from PIL import ImageDraw
        os.makedirs(a.debug, exist_ok=True)
        img = Image.fromarray(im).resize((im.shape[1] // 2, im.shape[0] // 2)); dr = ImageDraw.Draw(img)
        def draw(edges, col, w):
            for e in edges:
                dr.line([(e[4][i] // 2, e[4][i + 1] // 2) for i in range(0, len(e[4]), 2)], fill=col, width=w)
        draw([e for e in boat_edges if e[3] == 0], (0, 120, 255), 4)
        draw([e for e in boat_edges if e[3] in (1, 3)], (255, 255, 0), 3)
        draw(ship_edges, (255, 0, 255), 3)
        for k, (p, d) in ports.items():
            dr.ellipse((p[0] * F // 2 - 8, p[1] * F // 2 - 8, p[0] * F // 2 + 8, p[1] * F // 2 + 8), outline=(0, 255, 0), width=3)
        img.save(os.path.join(a.debug, 'agua.png'))


if __name__ == '__main__':
    main()

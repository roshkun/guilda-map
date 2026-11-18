"""Funções para transformar uma máscara de linhas (estradas, trilhas, ferrovia) em um grafo.

máscara -> esqueleto -> grafo (nós = pontas/cruzamentos, arestas = trechos com caminho em pixels)
-> poda de espinhas -> ligação de pequenos vãos -> encaixe de cidades no grafo.
"""
import math
import numpy as np
import cv2
from scipy import ndimage as ndi
from scipy.spatial import cKDTree
from skimage.morphology import skeletonize

NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def seg_len(path):
    p = np.asarray(path, dtype=np.float64)
    if len(p) < 2:
        return 0.0
    d = np.diff(p, axis=0)
    return float(np.sqrt((d ** 2).sum(1)).sum())


class Graph:
    def __init__(self):
        self.nodes = {}      # id -> (x, y)
        self.edges = {}      # id -> dict(a, b, path[(x,y)...], kind)
        self.nid = 0
        self.eid = 0

    def add_node(self, x, y):
        self.nid += 1
        self.nodes[self.nid] = (int(x), int(y))
        return self.nid

    def add_edge(self, a, b, path, kind=0):
        self.eid += 1
        self.edges[self.eid] = dict(a=a, b=b, path=[(int(x), int(y)) for x, y in path], kind=kind)
        return self.eid

    def adj(self):
        ad = {n: [] for n in self.nodes}
        for e, d in self.edges.items():
            ad[d['a']].append(e)
            if d['b'] != d['a']:
                ad[d['b']].append(e)
        return ad


def skeleton_from_mask(mask, close=9, min_area=6):
    m = mask.astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    small = np.where(st[:, cv2.CC_STAT_AREA] < min_area)[0]
    small = small[small != 0]
    if len(small):
        m[np.isin(lab, small)] = 0
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close, close))
    # dilata (em vez de fechar) para unir os pontos das trilhas pontilhadas; o esqueleto volta ao centro da linha
    closed = cv2.dilate(m, k)
    sk = skeletonize(closed > 0)
    return sk


def trace_graph(sk):
    """Constrói o grafo a partir de um esqueleto booleano."""
    H, W = sk.shape
    k = np.ones((3, 3), np.uint8)
    deg = cv2.filter2D(sk.astype(np.uint8), -1, k, borderType=cv2.BORDER_CONSTANT) - sk.astype(np.uint8)
    deg = deg * sk
    junction = sk & (deg >= 3)
    endpoint = sk & (deg == 1)
    isolated = sk & (deg == 0)
    nodemask = junction | endpoint
    # agrupa pixels de cruzamento adjacentes em um único nó
    lab, nlab = ndi.label(nodemask, structure=np.ones((3, 3)))
    g = Graph()
    comp_node = {}
    coms = ndi.center_of_mass(nodemask, lab, range(1, nlab + 1))
    objs = ndi.find_objects(lab)
    for i in range(1, nlab + 1):
        ys, xs = np.nonzero(lab[objs[i - 1]] == i)
        ys = ys + objs[i - 1][0].start
        xs = xs + objs[i - 1][1].start
        # pixel representativo: o mais próximo do centro de massa
        cy, cx = coms[i - 1]
        j = int(np.argmin((ys - cy) ** 2 + (xs - cx) ** 2))
        comp_node[i] = g.add_node(xs[j], ys[j])
    visited = np.zeros_like(sk)
    # percorre a partir de cada pixel de nó
    node_pixels = np.argwhere(nodemask)
    for y, x in node_pixels:
        na = comp_node[lab[y, x]]
        for dy, dx in NB:
            yy, xx = y + dy, x + dx
            if not (0 <= yy < H and 0 <= xx < W) or not sk[yy, xx]:
                continue
            if nodemask[yy, xx]:
                continue   # dentro do mesmo agrupamento (ou nó vizinho): ignora
            if visited[yy, xx]:
                continue
            path = [(x, y), (xx, yy)]
            visited[yy, xx] = True
            cy_, cx_ = yy, xx
            end_node = None
            while True:
                nxt = None
                for ey, ex in NB:
                    ny, nx = cy_ + ey, cx_ + ex
                    if not (0 <= ny < H and 0 <= nx < W) or not sk[ny, nx]:
                        continue
                    if (nx, ny) == path[-2]:
                        continue
                    if nodemask[ny, nx]:
                        end_node = comp_node[lab[ny, nx]]
                        path.append((nx, ny))
                        nxt = 'end'
                        break
                    if not visited[ny, nx]:
                        nxt = (ny, nx)
                        break
                if nxt is None or nxt == 'end':
                    break
                cy_, cx_ = nxt
                visited[cy_, cx_] = True
                path.append((cx_, cy_))
            if end_node is None:
                # ciclo fechado sem nós: cria nó na ponta
                end_node = g.add_node(*path[-1])
            g.add_edge(na, end_node, path)
    # ciclos puros (sem nós) ficam de fora de propósito (são ruído)
    return g


def collapse_deg2(g, keep=()):
    """Une arestas em nós de grau 2 (exceto nós em keep)."""
    changed = True
    while changed:
        changed = False
        ad = g.adj()
        for n, es in list(ad.items()):
            if n in keep or n not in g.nodes:
                continue
            es = list(dict.fromkeys(es))
            if len(es) != 2:
                continue
            e1, e2 = es
            d1, d2 = g.edges[e1], g.edges[e2]
            if e1 == e2:
                continue
            # orienta para p1 terminar em n e p2 começar em n
            p1 = d1['path'] if d1['b'] == n else d1['path'][::-1]
            a1 = d1['a'] if d1['b'] == n else d1['b']
            p2 = d2['path'] if d2['a'] == n else d2['path'][::-1]
            b2 = d2['b'] if d2['a'] == n else d2['a']
            if a1 == n or b2 == n:
                continue
            g.add_edge(a1, b2, p1 + p2[1:], max(d1['kind'], d2['kind']))
            del g.edges[e1], g.edges[e2], g.nodes[n]
            changed = True
            break


def prune_spurs(g, min_len=25, keep=()):
    changed = True
    while changed:
        changed = False
        ad = g.adj()
        for e, d in list(g.edges.items()):
            if e not in g.edges:
                continue
            la = len(ad[d['a']]); lb = len(ad[d['b']])
            term = (la == 1 and d['a'] not in keep) or (lb == 1 and d['b'] not in keep)
            both_term = la == 1 and lb == 1
            if term and not both_term and seg_len(d['path']) < min_len:
                del g.edges[e]
                changed = True
        if changed:
            used = set()
            for d in g.edges.values():
                used.add(d['a']); used.add(d['b'])
            for n in list(g.nodes):
                if n not in used and n not in keep:
                    del g.nodes[n]
            collapse_deg2(g, keep)
    # remove componentes minúsculas
    return g


def drop_small_components(g, min_len):
    ad = g.adj()
    seen = set()
    for n0 in list(g.nodes):
        if n0 in seen:
            continue
        stack = [n0]; comp = set([n0]); tot = 0.0; es = set()
        while stack:
            n = stack.pop()
            for e in ad[n]:
                if e in es:
                    continue
                es.add(e)
                d = g.edges[e]
                tot += seg_len(d['path'])
                for m in (d['a'], d['b']):
                    if m not in comp:
                        comp.add(m); stack.append(m)
        seen |= comp
        if tot < min_len:
            for e in es:
                g.edges.pop(e, None)
            for n in comp:
                g.nodes.pop(n, None)


def bridge_gaps(g, radius=70, max_angle=65, tol_other=True):
    """Liga pontas soltas a outro componente próximo (vãos sob rótulos/ícones)."""
    ad = g.adj()
    ends = [n for n, es in ad.items() if len(set(es)) == 1]
    # componente de cada nó
    comp = {}
    cid = 0
    for n0 in g.nodes:
        if n0 in comp:
            continue
        cid += 1; stack = [n0]; comp[n0] = cid
        while stack:
            n = stack.pop()
            for e in ad[n]:
                d = g.edges[e]
                for m in (d['a'], d['b']):
                    if m not in comp:
                        comp[m] = cid; stack.append(m)
    pts = []; owner = []
    for e, d in g.edges.items():
        for i, (x, y) in enumerate(d['path'][::2]):
            pts.append((x, y)); owner.append((e, i * 2))
    if not pts:
        return 0
    tree = cKDTree(np.array(pts, dtype=np.float64))
    added = 0
    props = []
    for n in ends:
        x, y = g.nodes[n]
        e0 = list(set(ad[n]))[0]
        d0 = g.edges[e0]
        path = d0['path'] if d0['a'] == n else d0['path'][::-1]
        tail = path[min(len(path) - 1, 14)]
        tx, ty = x - tail[0], y - tail[1]
        tn = math.hypot(tx, ty) or 1.0
        best = None
        for j in tree.query_ball_point([x, y], radius):
            e, idx = owner[j]
            dd = g.edges[e]
            ca = comp[dd['a']]
            if ca == comp[n]:
                continue
            px, py = pts[j]
            vx, vy = px - x, py - y
            vn = math.hypot(vx, vy) or 1.0
            ang = math.degrees(math.acos(max(-1, min(1, (tx * vx + ty * vy) / (tn * vn)))))
            if ang > max_angle:
                continue
            score = vn * (1 + ang / 90.0)
            if best is None or score < best[0]:
                best = (score, (px, py))
        if best:
            props.append((n, best[1], d0['kind']))
    pix2edge = {}
    for e, d in g.edges.items():
        for p in d['path']:
            pix2edge[p] = e
    for n, pix, kind in props:
        if n not in g.nodes:
            continue
        m = split_at_pixel(g, pix2edge, pix)
        if m is None or m == n:
            continue
        x, y = g.nodes[n]
        g.add_edge(n, m, [(x, y), g.nodes[m]], kind)
        added += 1
    return added


def split_edge(g, e, idx):
    """Divide a aresta e no índice idx do caminho; devolve o nó criado (ou existente)."""
    d = g.edges[e]
    path = d['path']
    idx = max(0, min(len(path) - 1, idx))
    if idx == 0:
        return d['a']
    if idx == len(path) - 1:
        return d['b']
    n = g.add_node(*path[idx])
    a, b, kind = d['a'], d['b'], d['kind']
    del g.edges[e]
    g.add_edge(a, n, path[:idx + 1], kind)
    g.add_edge(n, b, path[idx:], kind)
    return n


def split_at_pixel(g, pix2edge, pix):
    e = pix2edge.get(pix)
    if e is None or e not in g.edges:
        return None
    d = g.edges[e]
    n = split_edge(g, e, d['path'].index(pix))
    for e2, d2 in g.edges.items():
        if d2['a'] == n or d2['b'] == n:
            for p in d2['path']:
                pix2edge[p] = e2
    return n


def attach_points(g, points, snap=45, hub=40):
    """Encaixa pontos (cidades) no grafo.

    Cria um nó para cada ponto e o liga (aresta reta) ao pixel mais próximo do grafo e
    a todas as pontas soltas num raio 'hub' (estradas que terminam no ícone da cidade).
    Retorna ({chave: nó}, {chave: distância_px_ao_grafo})."""
    out, offs = {}, {}
    if not g.edges:
        return out, offs
    pts = []
    pix2edge = {}
    for e, d in g.edges.items():
        for (x, y) in d['path']:
            pts.append((x, y)); pix2edge[(x, y)] = e
    tree = cKDTree(np.array(pts, dtype=np.float64))
    ad = g.adj()
    ends = [n for n, es in ad.items() if len(set(es)) == 1]
    etree = cKDTree(np.array([g.nodes[n] for n in ends], dtype=np.float64)) if ends else None
    for key, (px, py) in points.items():
        dist, j = tree.query([px, py])
        if dist > snap:
            continue
        x, y = pts[j]
        e = pix2edge.get((x, y))
        if e is None or e not in g.edges:
            continue
        d = g.edges[e]
        idx = d['path'].index((x, y))
        kind = d['kind']
        n = split_edge(g, e, idx)
        # atualiza índice pixel->aresta para as novas arestas
        for e2, d2 in g.edges.items():
            if d2['a'] == n or d2['b'] == n:
                for p in d2['path']:
                    pix2edge[p] = e2
        m = g.add_node(px, py)
        g.add_edge(m, n, [(px, py), g.nodes[n]], kind)
        if etree is not None:
            for k in etree.query_ball_point([px, py], hub):
                en = ends[k]
                if en in g.nodes and en != n:
                    g.add_edge(m, en, [(px, py), g.nodes[en]], kind)
        out[key] = m
        offs[key] = float(dist)
    return out, offs


def simplify(path, eps=1.5):
    a = np.array(path, dtype=np.int32).reshape(-1, 1, 2)
    if len(a) < 3:
        return [tuple(map(int, p)) for p in path]
    s = cv2.approxPolyDP(a, eps, False).reshape(-1, 2)
    return [tuple(map(int, p)) for p in s]

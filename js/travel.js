/* Rotas e tempo de viagem — a pé, a cavalo, de carroça, Ferroáurea (trem) e Aeronau (dirigível mágico).
 * Usa data/network.json (gerado por tools/build_network.py) e a seção "travel" de data/config.json.
 * Modelo: grafo único com nós de terra (estradas/trilhas), nós da ferrovia, nós do Aeronau e um "hub" por lugar.
 * Embarcar no trem/Aeronau custa o tempo de espera; descer é grátis. Dijkstra com heap binário.
 */
(function () {
  'use strict';

  var api, cfgT, net, water, kmPx;
  var adj = [], nodeMarkers = {}, hubOf = {}, hubName = {}, gN = 0;
  var layer = null, ready = false;
  var state = { from: null, to: null, base: 'foot', train: false, air: false, boat: false, ship: false };
  var MODES = ['foot', 'horse', 'cart'];
  var COLS = [{ t: 0, a: 0, b: 0, label: 'Só terra' }, { t: 1, a: 0, b: 0, label: '+ Ferro-áurea' },
              { t: 0, a: 1, b: 0, label: '+ Aeronau' }, { t: 0, a: 0, b: 1, label: '+ Barcos' },
              { t: 1, a: 1, b: 1, label: 'Tudo' }];
  var STYLE = {
    road:  { color: '#f0c85a', weight: 4, opacity: 0.95 },
    trail: { color: '#d98a5a', weight: 4, opacity: 0.95, dashArray: '6 6' },
    off:   { color: '#b8b8b8', weight: 3, opacity: 0.9, dashArray: '2 8' },
    train: { color: '#ffffff', weight: 5, opacity: 0.95, dashArray: '12 5 2 5' },
    air:   { color: '#6fd3ff', weight: 4, opacity: 0.95, dashArray: '3 9' },
    river: { color: '#3a8dff', weight: 4, opacity: 0.95 },
    sea_s: { color: '#38d6c4', weight: 4, opacity: 0.95, dashArray: '8 5' },
    sea_l: { color: '#7a5cff', weight: 5, opacity: 0.95, dashArray: '14 6' }
  };
  var LEG_NAME = { road: 'Estrada', trail: 'Trilha', off: 'Fora de trilha', train: 'Ferroáurea', air: 'Aeronau',
                   river: 'Rio', sea_s: 'Barco pequeno (costa)', sea_l: 'Navio grande' };
  var LEG_ICON = { road: '🛤️', trail: '🥾', off: '🌿', train: '🚂', air: '🎈', river: '🛶', sea_s: '⛵', sea_l: '🚢', wait: '⏳' };
  var WAIT_NAME = { train: 'Ferroáurea', air: 'Aeronau', boat: 'barco pequeno', ship: 'navio' };

  function $(id) { return document.getElementById(id); }

  /* ---------- heap ---------- */
  function Heap() { this.a = []; }
  Heap.prototype.push = function (d, n) {
    var a = this.a, i = a.length; a.push([d, n]);
    while (i > 0) { var p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; var t = a[p]; a[p] = a[i]; a[i] = t; i = p; }
  };
  Heap.prototype.pop = function () {
    var a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; var i = 0, n = a.length;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < n && a[l][0] < a[m][0]) m = l;
        if (r < n && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        var t = a[m]; a[m] = a[i]; a[i] = t; i = m;
      }
    }
    return top;
  };

  /* ---------- construção do grafo ---------- */
  function addNode() { adj.push([]); return adj.length - 1; }
  function link(a, b, type, km, flat, flow) {
    adj[a].push({ to: b, type: type, km: km, flat: flat, rev: false, flow: flow || 0 });
    adj[b].push({ to: a, type: type, km: km, flat: flat, rev: true, flow: -(flow || 0) });
  }
  function dist(ax, ay, bx, by) { return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by)); }

  function build() {
    kmPx = net.kmPerPx || cfgT.kmPerPx;
    var gNodes = net.ground.nodes, tNodes = net.train.nodes;
    gN = gNodes.length;
    for (var i = 0; i < gN + tNodes.length; i++) addNode();

    net.ground.edges.forEach(function (e) {
      link(e[0], e[1], e[3] === 1 ? 'trail' : 'road', e[2] * kmPx, e[4]);
    });
    net.train.edges.forEach(function (e) {
      link(gN + e[0], gN + e[1], 'train', e[2] * kmPx, e[4]);
    });
    function addNM(node, id) { (nodeMarkers[node] = nodeMarkers[node] || []).push(id); }
    Object.keys(net.ground.points).forEach(function (id) { addNM(net.ground.points[id], id); });
    Object.keys(net.train.points).forEach(function (id) { addNM(gN + net.train.points[id], id); });

    // componente principal da rede de terra (para ligar lugares fora de estrada)
    var par = gNodes.map(function (_, i) { return i; });
    function find(a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }
    net.ground.edges.forEach(function (e) { par[find(e[0])] = find(e[1]); });
    var size = {}, root;
    Object.keys(net.ground.points).forEach(function (id) {
      var r = find(net.ground.points[id]); size[r] = (size[r] || 0) + 1;
      if (root === undefined || size[r] > size[root]) root = r;
    });

    var maxOff = (cfgT.offroadMaxKm || 250) / kmPx, detour = cfgT.offroadDetour || 1.3;
    function nearest(x, y, onlyMain) {
      var best = -1, bd = Infinity;
      for (var i = 0; i < gN; i++) {
        if (onlyMain && find(i) !== root) continue;
        var d = dist(x, y, gNodes[i][0], gNodes[i][1]);
        if (d < bd) { bd = d; best = i; }
      }
      return best < 0 ? null : { i: best, d: bd };
    }

    // água: rios + costa (barco pequeno) e mar aberto (navio grande)
    var boatPts = {}, shipPts = {};
    if (water) {
      var bb = adj.length;
      water.boat.nodes.forEach(addNode);
      water.boat.edges.forEach(function (e) {
        link(bb + e[0], bb + e[1], e[3] === 1 ? 'sea_s' : 'river', e[2] * kmPx, e[4], e[3] === 1 ? 0 : e[5]);
      });
      Object.keys(water.boat.points).forEach(function (id) {
        boatPts[id] = water.boat.points[id].map(function (n) { return bb + n; });
        boatPts[id].forEach(function (n) { addNM(n, id); });
      });
      var sb = adj.length;
      water.ship.nodes.forEach(addNode);
      water.ship.edges.forEach(function (e) { link(sb + e[0], sb + e[1], 'sea_l', e[2] * kmPx, e[4], 0); });
      Object.keys(water.ship.points).forEach(function (id) {
        shipPts[id] = water.ship.points[id].map(function (n) { return sb + n; });
        shipPts[id].forEach(function (n) { addNM(n, id); });
      });
    }

    // um hub por lugar
    Object.keys(api.entries).forEach(function (id) {
      var m = api.entries[id].data, h = addNode();
      hubOf[id] = h; hubName[h] = m.name;
      var g = net.ground.points[id], t = net.train.points[id];
      if (g != null) link(h, g, 'link', 0, null);
      if (t != null) {
        adj[h].push({ to: gN + t, type: 'board', mode: 'train', id: id });
        adj[gN + t].push({ to: h, type: 'alight', id: id });
      }
      [[boatPts[id], 'boat'], [shipPts[id], 'ship']].forEach(function (bp) {
        (bp[0] || []).forEach(function (n) {
          adj[h].push({ to: n, type: 'board', mode: bp[1], id: id });
          adj[n].push({ to: h, type: 'alight', id: id });
        });
      });
      if (g == null) {                           // fora das estradas: liga em linha reta ao ponto mais próximo
        var seen = {};
        [nearest(m.x, m.y, false), nearest(m.x, m.y, true)].forEach(function (n) {
          if (!n || n.d > maxOff || seen[n.i]) return; seen[n.i] = 1;
          var p = gNodes[n.i];
          link(h, n.i, 'off', n.d * kmPx * detour, [m.x, m.y, p[0], p[1]]);
        });
      }
    });

    // Aeronau: grafo completo em linha reta entre as estações (por padrão, todas as capitais)
    var st = (cfgT.aeronau && cfgT.aeronau.stations) || 'capitals';
    var ids = st === 'capitals' ? Object.keys(api.entries).filter(function (id) { return api.entries[id].data.category === 'capital'; }) :
      st.filter(function (id) { return api.entries[id]; });
    var air = ids.map(function (id) {
      var n = addNode(), h = hubOf[id];
      adj[h].push({ to: n, type: 'board', mode: 'air', id: id });
      adj[n].push({ to: h, type: 'alight', id: id });
      addNM(n, id);
      return { id: id, n: n, m: api.entries[id].data };
    });
    for (var a = 0; a < air.length; a++) for (var b = a + 1; b < air.length; b++) {
      var A = air[a].m, B = air[b].m;
      link(air[a].n, air[b].n, 'air', dist(A.x, A.y, B.x, B.y) * kmPx, [A.x, A.y, B.x, B.y]);
    }
    cfgT._airIds = ids;
  }

  /* ---------- custo e Dijkstra ---------- */
  function cost(e, o) {
    switch (e.type) {
      case 'road': case 'trail': case 'off':
        var sp = cfgT.speeds[o.base][e.type]; return sp ? e.km / sp : Infinity;
      case 'train': return o.train ? e.km / cfgT.train.speedKmh : Infinity;
      case 'air': return o.air ? e.km / cfgT.aeronau.speedKmh : Infinity;
      case 'river':
        if (!o.boat) return Infinity;
        var B = cfgT.boats.small, v = B.riverKmh + (e.flow > 0 ? B.currentKmh : e.flow < 0 ? -B.currentKmh : 0);
        return e.km / Math.max(v, 1.5);
      case 'sea_s': return o.boat ? e.km / cfgT.boats.small.speedKmh : Infinity;
      case 'sea_l': return o.ship ? e.km / cfgT.boats.ship.speedKmh : Infinity;
      case 'board':
        if (e.mode === 'train') return o.train ? cfgT.train.waitHours : Infinity;
        if (e.mode === 'air') return o.air ? cfgT.aeronau.waitHours : Infinity;
        if (e.mode === 'boat') return o.boat ? cfgT.boats.small.waitHours : Infinity;
        return o.ship ? cfgT.boats.ship.waitHours : Infinity;
      default: return 0;
    }
  }

  function dijkstra(src, dst, o) {
    var n = adj.length, d = new Float64Array(n).fill(Infinity), pn = new Int32Array(n).fill(-1), pe = new Array(n);
    var heap = new Heap(); d[src] = 0; heap.push(0, src);
    while (heap.a.length) {
      var top = heap.pop(), u = top[1];
      if (top[0] > d[u]) continue;
      if (u === dst) break;
      var es = adj[u];
      for (var i = 0; i < es.length; i++) {
        var e = es[i], c = cost(e, o);
        if (c === Infinity) continue;
        var nd = d[u] + c;
        if (nd < d[e.to]) { d[e.to] = nd; pn[e.to] = u; pe[e.to] = e; heap.push(nd, e.to); }
      }
    }
    if (d[dst] === Infinity) return null;
    var path = [], v = dst;
    while (v !== src) { path.push({ e: pe[v], to: v }); v = pn[v]; }
    return path.reverse();
  }

  function orient(e) {
    var f = e.flat; if (!f) return [];
    if (!e.rev) return f.slice();
    var out = []; for (var i = f.length - 2; i >= 0; i -= 2) out.push(f[i], f[i + 1]);
    return out;
  }

  function route(fromId, toId, o) {
    var path = dijkstra(hubOf[fromId], hubOf[toId], o);
    if (!path) return null;
    var segs = [], cur = null, totH = 0, totKm = 0, groundH = 0;
    var from = api.entries[fromId].data.name, to = api.entries[toId].data.name;
    function seg(type, flow) {
      if (cur && cur.type === type && !cur.closed && (type !== 'river' || cur.flow === flow)) return cur;
      cur = { type: type, flow: flow, km: 0, h: 0, pts: [], via: [] }; segs.push(cur); return cur;
    }
    path.forEach(function (st) {
      var e = st.e, h = cost(e, o);
      totH += h;
      if (e.type === 'road' || e.type === 'trail' || e.type === 'off') {
        var s = seg(e.type); s.km += e.km; s.h += h; s.pts = s.pts.concat(orient(e)); groundH += h; totKm += e.km;
        (nodeMarkers[st.to] || []).forEach(function (id) { s.via.push(id); });
      } else if (e.type === 'river' || e.type === 'sea_s' || e.type === 'sea_l' || e.type === 'train' || e.type === 'air') {
        var t = seg(e.type, e.flow); t.km += e.km; t.h += h; t.pts = t.pts.concat(orient(e)); totKm += e.km;
        (nodeMarkers[st.to] || []).forEach(function (id) { t.via.push(id); });
      } else if (e.type === 'board') {
        segs.push({ type: 'wait', mode: e.mode, at: hubName[hubOf[e.id]], h: h, km: 0, pts: [], via: [] });
        if (e.mode === 'train' || e.mode === 'air') { cur = { type: e.mode, km: 0, h: 0, pts: [], via: [], from: hubName[hubOf[e.id]] }; segs.push(cur); }
        else cur = null;
      } else if (e.type === 'alight') {
        if (cur && (cur.type === 'train' || cur.type === 'air')) { cur.to = hubName[hubOf[e.id]]; cur.closed = true; }
        cur = null;
      }
    });
    segs.forEach(function (s) {
      var seen = {}, names = [];
      s.via.forEach(function (id) {
        var m = api.entries[id].data;
        if (m.name === from || m.name === to || m.name === s.from || m.name === s.to || seen[id]) return;
        if (['capital', 'city', 'town', 'fort'].indexOf(m.category) < 0) return;
        seen[id] = 1; names.push(m.name);
      });
      s.via = names;
    });
    segs = segs.filter(function (s) { return s.type === 'wait' || s.km > 0; });
    var hpd = cfgT.hoursPerDay[o.base] || 8;
    var days = groundH / hpd + (totH - groundH) / 24;
    return { hours: totH, km: totKm, groundH: groundH, days: days, segs: segs };
  }

  /* ---------- formatação ---------- */
  function fmtDur(h) {
    if (h < 1 / 60) return '0 min';
    if (h < 1) return Math.round(h * 60) + ' min';
    if (h < 48) { var hh = Math.floor(h), mm = Math.round((h - hh) * 60); if (mm === 60) { hh++; mm = 0; } return hh + ' h' + (mm ? ' ' + (mm < 10 ? '0' : '') + mm + ' min' : ''); }
    return Math.round(h) + ' h';
  }
  function fmtShort(r) {
    if (!r) return '—';
    return r.days < 1 ? fmtDur(r.hours) : (r.days.toFixed(1).replace('.', ',') + ' d');
  }
  function fmtDays(d) { return d < 1 ? 'menos de 1 dia' : d.toFixed(1).replace('.', ',') + (d >= 1.95 ? ' dias' : ' dia'); }
  function fmtKm(km) { return Math.round(km).toLocaleString('pt-BR') + ' km'; }
  var esc = function (s) { return api.esc(s); };

  /* ---------- cálculo + interface ---------- */
  function opts() { return { base: state.base, train: !!state.train, air: !!state.air, boat: !!state.boat, ship: !!state.ship }; }

  function update(fit) {
    var out = $('rt-out'); clearLayer();
    $('route-clear').hidden = !(state.from || state.to);
    api.writeHash();
    if (!state.from || !state.to) { out.innerHTML = '<p class="rt-hint">Escolha origem e destino (ou use “Sair daqui / Chegar aqui” no pin).</p>'; return; }
    if (state.from === state.to) { out.innerHTML = '<p class="rt-hint">Origem e destino são o mesmo lugar.</p>'; return; }

    var r = route(state.from, state.to, opts());
    var html = '';
    if (!r) {
      html += '<p class="rt-warn">Sem caminho com as opções selecionadas. ' +
        (state.base === 'cart' ? 'A carroça não passa por todas as trilhas fora de estrada. ' : '') +
        'Tente outro modo ou ative Ferroáurea/Aeronau.</p>';
    } else {
      drawRoute(r, fit);
      html += '<div class="rt-summary"><b>' + fmtDays(r.days) + '</b> <span>· ' + fmtKm(r.km) + ' · ' + fmtDur(r.hours) + ' de percurso</span></div>';
      html += '<ol class="rt-legs">' + r.segs.map(function (s) {
        if (s.type === 'wait') return '<li class="wait">' + LEG_ICON.wait + ' Espera para embarcar (' + WAIT_NAME[s.mode] + ') em ' + esc(s.at) + ' · ' + fmtDur(s.h) + '</li>';
        var title = LEG_ICON[s.type] + ' <b>' + LEG_NAME[s.type] + (s.type === 'river' ? (s.flow > 0 ? ' (descendo)' : s.flow < 0 ? ' (subindo)' : '') : '') + '</b>' + (s.from ? ': ' + esc(s.from) + ' → ' + esc(s.to || '') : '');
        return '<li class="' + s.type + '">' + title + '<br><small>' + fmtKm(s.km) + ' · ' + fmtDur(s.h) +
          (s.via.length ? ' · passando por ' + s.via.map(esc).join(', ') : '') + '</small></li>';
      }).join('') + '</ol>';
    }
    html += compareTable();
    out.innerHTML = html;
  }

  function compareTable() {
    var best = Infinity, cells = [];
    MODES.forEach(function (m) {
      COLS.forEach(function (c) {
        var r = route(state.from, state.to, { base: m, train: !!c.t, air: !!c.a, boat: !!c.b, ship: !!c.b });
        cells.push({ m: m, c: c, r: r });
        if (r && r.days < best - 1e-9) best = r.days;
      });
    });
    var rows = MODES.map(function (m) {
      return '<tr><th>' + cfgT.speeds[m].icon + ' ' + esc(cfgT.speeds[m].label) + '</th>' + cells.filter(function (x) { return x.m === m; }).map(function (x) {
        var sel = state.base === m && !!state.train === !!x.c.t && !!state.air === !!x.c.a && !!state.boat === !!x.c.b && !!state.ship === !!x.c.b;
        var isBest = x.r && Math.abs(x.r.days - best) < 1e-9;
        return '<td><button data-m="' + m + '" data-t="' + x.c.t + '" data-a="' + x.c.a + '" data-b="' + x.c.b + '" class="' + (sel ? 'sel ' : '') + (isBest ? 'best' : '') + '" ' +
          (x.r ? 'title="' + fmtKm(x.r.km) + ' · ' + fmtDur(x.r.hours) + '"' : 'disabled') + '>' + fmtShort(x.r) + (isBest ? ' ★' : '') + '</button></td>';
      }).join('') + '</tr>';
    }).join('');
    return '<table class="rt-table"><thead><tr><th></th>' + COLS.map(function (c) { return '<th>' + c.label + '</th>'; }).join('') + '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '<small class="rt-note">★ = mais rápido. Dias contam ' + MODES.map(function (m) { return (cfgT.hoursPerDay[m] || 8) + ' h/dia ' + cfgT.speeds[m].label.toLowerCase(); }).join(', ') +
      '; trem, Aeronau e barcos contam 24 h/dia.</small>';
  }

  function clearLayer() { if (layer) { api.map.removeLayer(layer); layer = null; } }
  function drawRoute(r, fit) {
    layer = L.layerGroup().addTo(api.map);
    var all = [];
    r.segs.forEach(function (s) {
      if (s.pts.length < 4) return;
      var ll = []; for (var i = 0; i < s.pts.length; i += 2) ll.push(api.toLatLng(s.pts[i], s.pts[i + 1]));
      all = all.concat(ll);
      L.polyline(ll, { color: '#000', weight: STYLE[s.type].weight + 3, opacity: 0.55, interactive: false }).addTo(layer);
      L.polyline(ll, L.extend({ interactive: false, lineCap: 'round' }, STYLE[s.type])).addTo(layer);
    });
    [[state.from, '#3ddc84'], [state.to, '#ff5d5d']].forEach(function (p) {
      var m = api.entries[p[0]].data;
      L.circleMarker(api.toLatLng(m.x, m.y), { radius: 9, color: '#000', weight: 2, fillColor: p[1], fillOpacity: 1, interactive: false }).addTo(layer);
      all.push(api.toLatLng(m.x, m.y));
    });
    if (fit && all.length) {
      var pad = window.innerWidth > 720 ? [[40, 40], [40, 40]] : [[30, 30], [30, 30]];
      api.map.fitBounds(L.latLngBounds(all), {
        paddingTopLeft: [(window.innerWidth > 720 ? 350 : 30), 40], paddingBottomRight: [40, 40], maxZoom: 4, animate: true
      });
    }
  }

  /* ---------- seleção de origem/destino ---------- */
  function setPlace(which, id, fit) {
    state[which] = id;
    var m = id && api.entries[id] ? api.entries[id].data : null;
    $('rt-' + which).value = m ? m.name : '';
    update(fit !== false);
  }

  function bindPicker(which) {
    var input = $('rt-' + which), list = $('rt-' + which + '-list');
    function render() {
      var q = input.value.trim();
      if (!q) { list.hidden = true; return; }
      var res = api.search(q).slice(0, 8);
      list.hidden = false;
      list.innerHTML = res.length ? res.map(function (m) {
        var c = api.catById[m.category];
        return '<li data-id="' + esc(m.id) + '"><span>' + esc(c.icon) + '</span><span>' + esc(m.name) + '</span><small>' + esc(c.name) + '</small></li>';
      }).join('') : '<li class="empty">Nada encontrado</li>';
    }
    input.addEventListener('input', function () { if (!input.value.trim()) { state[which] = null; update(false); } render(); });
    input.addEventListener('focus', function () { input.select(); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { var li = list.querySelector('li[data-id]'); if (li) { list.hidden = true; setPlace(which, li.dataset.id); } }
      else if (ev.key === 'Escape') list.hidden = true;
    });
    list.addEventListener('click', function (ev) {
      var li = ev.target.closest('li[data-id]'); if (!li) return;
      list.hidden = true; setPlace(which, li.dataset.id);
    });
    document.addEventListener('click', function (ev) { if (!ev.target.closest('#rt-' + which + '-wrap')) list.hidden = true; });
  }

  function syncControls() {
    var r = document.querySelector('input[name="rt-base"][value="' + state.base + '"]'); if (r) r.checked = true;
    $('rt-train').checked = !!state.train; $('rt-air').checked = !!state.air;
    $('rt-boat').checked = !!state.boat; $('rt-ship').checked = !!state.ship;
  }

  function bindUi() {
    bindPicker('from'); bindPicker('to');
    $('rt-modes').innerHTML = MODES.map(function (m) {
      return '<label><input type="radio" name="rt-base" value="' + m + '"' + (state.base === m ? ' checked' : '') + '> ' + cfgT.speeds[m].icon + ' ' + esc(cfgT.speeds[m].label) + '</label>';
    }).join('');
    $('rt-modes').addEventListener('change', function (ev) { state.base = ev.target.value; update(false); });
    $('rt-train').onchange = function () { state.train = this.checked; update(false); };
    $('rt-air').onchange = function () { state.air = this.checked; update(false); };
    $('rt-boat').onchange = function () { state.boat = this.checked; update(false); };
    $('rt-ship').onchange = function () { state.ship = this.checked; update(false); };
    $('rt-swap').onclick = function () { var f = state.from, t = state.to; setPlace('from', t, false); setPlace('to', f, false); };
    $('route-clear').onclick = function () { state.from = state.to = null; $('rt-from').value = ''; $('rt-to').value = ''; update(false); };
    $('rt-out').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-m]'); if (!b || b.disabled) return;
      state.base = b.dataset.m; state.train = b.dataset.t === '1'; state.air = b.dataset.a === '1'; state.boat = state.ship = b.dataset.b === '1';
      syncControls(); update(true);
    });
    // botões dentro dos popups dos pins
    document.addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-route]'); if (!b) return;
      api.map.closePopup();
      openPanel();
      setPlace(b.dataset.route === 'from' ? 'from' : 'to', b.dataset.id, true);
    });
    $('rt-train-label').title = 'Ferroáurea: ferrovia branca tracejada em Picoáureo (' + cfgT.train.speedKmh + ' km/h)';
    $('rt-air-label').title = 'Aeronau: liga as capitais em linha reta (' + cfgT.aeronau.speedKmh + ' km/h)';
  }

  function openPanel() {
    document.body.classList.remove('sidebar-closed');
    var p = $('route-panel'); if (p && p.scrollIntoView) p.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- hash ---------- */
  function extraHash() {
    if (!ready || !state.from || !state.to) return '';
    return '&r=' + encodeURIComponent(state.from) + ',' + encodeURIComponent(state.to) + '&b=' + state.base +
      (state.train ? '&t=1' : '') + (state.air ? '&a=1' : '') + ((state.boat ? 1 : 0) + (state.ship ? 2 : 0) ? '&w=' + ((state.boat ? 1 : 0) + (state.ship ? 2 : 0)) : '');
  }
  function readHash() {
    var p = {};
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var i = kv.indexOf('='); if (i > 0) p[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
    });
    if (!p.r) return;
    var ids = p.r.split(',');
    if (MODES.indexOf(p.b) >= 0) state.base = p.b;
    state.train = p.t === '1'; state.air = p.a === '1';
    var w = parseInt(p.w, 10) || 0; state.boat = !!(w & 1); state.ship = !!(w & 2);
    syncControls();
    var hasView = isFinite(parseFloat(p.x));
    if (api.entries[ids[0]]) { state.from = ids[0]; $('rt-from').value = api.entries[ids[0]].data.name; }
    if (api.entries[ids[1]]) { state.to = ids[1]; $('rt-to').value = api.entries[ids[1]].data.name; }
    update(!hasView);
  }

  /* ---------- API pública ---------- */
  window.GuildaTravel = {
    init: function (a) {
      api = a; cfgT = api.cfg.travel;
      var panel = $('route-panel');
      if (!cfgT) { if (panel) panel.hidden = true; return; }
      Promise.all([
        fetch('data/network.json').then(function (r) { return r.json(); }),
        fetch('data/water.json').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
      ]).then(function (res) {
        net = res[0]; water = res[1]; if (water && !cfgT.boats) water = null; build(); ready = true;
        api.extraHash = extraHash;
        bindUi(); readHash();
        update(false);
        if (!state.from) $('rt-out').innerHTML = '<p class="rt-hint">Escolha origem e destino (ou use “Sair daqui / Chegar aqui” no pin).</p>';
      }).catch(function (err) {
        console.error(err);
        if (panel) panel.hidden = true;
      });
    },
    route: function (a, b, o) { return ready ? route(a, b, o) : null; }
  };
})();

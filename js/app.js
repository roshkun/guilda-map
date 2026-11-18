/* Meu Mapa — mapa interativo sobre imagem (Leaflet, CRS.Simple)
 * Coordenadas nos JSON são em PIXELS da imagem, com origem no canto superior esquerdo (x → direita, y → baixo).
 */
(function () {
  'use strict';

  var HIDDEN_KEY = 'meumapa.hiddenMarkers';
  var CATS_KEY = 'meumapa.hiddenCats';

  var api = window.GuildaMap = {};
  var cfg, markers, catById = {}, map, H, W;
  var entries = {};            // id -> { data, cat, layer, area }
  var catGroups = {};          // catId -> { pins: L.LayerGroup, areas: L.LayerGroup }
  var catEnabled = {};         // catId -> bool
  var hiddenMarkers = {};      // ids ocultados pelo usuário
  var editMode = /[?&]edit\b/.test(location.search);

  /* ---------- utilidades ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function norm(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }
  function safeUrl(u) {           // só permite http(s) e caminhos relativos
    u = String(u || '');
    return /^(javascript|data|vbscript):/i.test(u.trim()) ? '#' : u;
  }
  function load(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (e) { return {}; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* ignora */ } }
  function toLatLng(x, y) { return L.latLng(-y, x); }   // y da imagem cresce para baixo
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, 2200);
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; });
    }
    return Promise.resolve(false);
  }

  /* ---------- carregamento ---------- */
  Promise.all([
    fetch('data/config.json').then(function (r) { return r.json(); }),
    fetch('data/markers.json').then(function (r) { return r.json(); })
  ]).then(function (res) {
    cfg = res[0]; markers = res[1];
    init();
  }).catch(function (err) {
    console.error(err);
    var ld0 = document.getElementById('loading'); if (ld0) ld0.hidden = true;
    document.body.insertAdjacentHTML('beforeend',
      '<p style="position:fixed;inset:40% 10% auto;z-index:3000;background:#400;padding:16px;border-radius:8px">' +
      'Erro ao iniciar o mapa: ' + esc(err && err.message || err) + '. Se abriu o arquivo direto, use um servidor local ' +
      '(ex.: <code>python3 -m http.server</code>).</p>');
  });

  /* ---------- inicialização ---------- */
  function init() {
    W = cfg.width; H = cfg.height;
    document.title = cfg.title;
    $('title').textContent = cfg.title;
    $('subtitle').textContent = cfg.subtitle || '';
    cfg.categories.forEach(function (c) { catById[c.id] = c; });

    var hiddenCats = load(CATS_KEY);
    cfg.categories.forEach(function (c) {
      catEnabled[c.id] = hiddenCats[c.id] === undefined ? c.visible !== false : !hiddenCats[c.id];
    });
    hiddenMarkers = load(HIDDEN_KEY);

    var bounds = L.latLngBounds([[-H, 0], [0, W]]);
    var crs = L.CRS.Simple, tiles = cfg.tiles;
    if (tiles) {
      // unitZoom = zoom em que 1 pixel de tela = 1 unidade das coordenadas dos JSON (grade de 8192).
      // Os tiles podem ter resolução maior (maxNativeZoom > unitZoom): mais detalhe, mesmas coordenadas.
      var uz = tiles.unitZoom != null ? tiles.unitZoom : tiles.maxNativeZoom;
      crs = L.extend({}, L.CRS.Simple, { transformation: new L.Transformation(1 / Math.pow(2, uz), 0, -1 / Math.pow(2, uz), 0) });
    }
    map = L.map('map', {
      crs: crs,
      minZoom: cfg.minZoom, maxZoom: cfg.maxZoom,
      zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 120,
      maxBounds: bounds.pad(0.25), maxBoundsViscosity: 0.8,
      attributionControl: false
    });
    if (tiles) {
      L.tileLayer(tiles.url, {
        tileSize: 256, minNativeZoom: 0, maxNativeZoom: tiles.maxNativeZoom,
        minZoom: cfg.minZoom, maxZoom: cfg.maxZoom, bounds: bounds, noWrap: true
      }).addTo(map);
    } else {
      L.imageOverlay(cfg.image, bounds).addTo(map);
    }

    cfg.categories.forEach(function (c) {
      catGroups[c.id] = { pins: L.layerGroup(), areas: L.layerGroup() };
    });
    markers.forEach(buildMarker);

    buildFilters();
    bindSearch();
    bindUi();
    applyHash(true);
    refresh();

    map.on('zoomend', refresh);
    map.on('moveend zoomend', writeHash);
    if (editMode) enableEditMode();
    api.cfg = cfg; api.map = map; api.entries = entries; api.markers = markers; api.catById = catById;
    api.toLatLng = toLatLng; api.esc = esc; api.search = search; api.writeHash = writeHash; api.toast = toast; api.focusMarker = focusMarker;
    if (window.GuildaTools) GuildaTools.init(api);
    if (window.GuildaTravel) GuildaTravel.init(api);
    var ld = $('loading'); if (ld) ld.hidden = true;
    window.addEventListener('hashchange', function () { applyHash(false); });
  }

  /* ---------- marcadores ---------- */
  function buildMarker(m) {
    var cat = catById[m.category];
    if (!cat) { console.warn('Categoria desconhecida:', m.category, m.id); return; }
    var color = cat.color || '#fff';
    var icon;
    if (cat.style === 'pin') {
      icon = L.divIcon({
        className: '',
        iconSize: [0, 0],
        html: '<div class="pin" style="--c:' + esc(color) + ';--s:' + (cat.size || 32) + 'px"><div class="bubble"><span>' + esc(m.icon || cat.icon) +
              '</span></div><span class="pin-name">' + esc(m.name) + '</span></div>'
      });
    } else {
      icon = L.divIcon({
        className: '',
        iconSize: [0, 0],
        html: '<div class="lbl ' + (cat.style === 'label-xl' ? 'lbl-xl' : 'lbl-lg') + '" style="--c:' + esc(color) + '">' +
              esc(m.name) + '</div>'
      });
    }
    var layer = L.marker(toLatLng(m.x, m.y), { icon: icon, keyboard: true, title: m.name, riseOnHover: true });
    layer.bindPopup(function () { return popupHtml(m, cat); }, { maxWidth: 320, minWidth: 240 });
    layer.on('click', function () { setMarkerInHash(m.id); });
    layer.on('contextmenu', function () { hideMarker(m.id); });
    layer.on('popupclose', function () { setMarkerInHash(null); });

    var area = null;
    if (m.area && m.area.length > 2) {
      area = L.polygon(m.area.map(function (p) { return toLatLng(p[0], p[1]); }), {
        color: color, weight: 2, opacity: 0.8, fillColor: color, fillOpacity: 0.12, dashArray: '6 6', interactive: false
      });
    }
    entries[m.id] = { data: m, cat: cat, layer: layer, area: area };
  }

  function popupHtml(m, cat) {
    var docs = (m.docs || []).map(function (d) {
      return '<li>📄 <a href="' + esc(safeUrl(d.url)) + '" target="_blank" rel="noopener">' + esc(d.title) + '</a></li>';
    }).join('');
    var img = '';
    if (m.image) {
      var ratio = m.imageRatio === '1:1' ? 'r-1-1' : 'r-16-9';
      img = '<img class="popup-img ' + ratio + '" src="' + esc(safeUrl(m.image)) + '" alt="' + esc(m.name) +
            '" loading="lazy" onerror="this.style.display=\'none\'">';
    }
    return '<div class="popup' + (m.image ? ' has-img' : '') + '"><div class="cat">' + esc(cat.icon) + ' ' + esc(cat.name) + '</div>' +
      '<h3>' + esc(m.name) + '</h3>' + img +
      (m.description ? '<p>' + esc(m.description) + '</p>' : '') +
      (docs ? '<ul>' + docs + '</ul>' : '') +
      (cfg.travel ? '<div class="popup-actions"><button data-route="from" data-id="' + esc(m.id) + '">🧭 Sair daqui</button><button data-route="stop" data-id="' + esc(m.id) + '">➕ Parada</button><button data-route="to" data-id="' + esc(m.id) + '">🏁 Chegar aqui</button></div>' : '') +
      '<div class="popup-actions sec"><button data-copylink="' + esc(m.id) + '">🔗 Copiar link</button></div>' + nearbyHtml(m) +
      (editMode ? '<div class="coords">x: ' + m.x + ', y: ' + m.y + '</div>' : '') + '</div>';
  }

  function nearbyHtml(m) {
    var km = cfg.travel && cfg.travel.kmPerPx, arr = [];
    Object.keys(entries).forEach(function (id) {
      var o = entries[id].data;
      if (id === m.id || o.category === 'country' || o.category === 'duchy') return;
      arr.push([Math.hypot(o.x - m.x, o.y - m.y), o]);
    });
    arr.sort(function (a, b) { return a[0] - b[0]; });
    if (!arr.length) return '';
    return '<div class="nearby"><b>Perto daqui</b><ul>' + arr.slice(0, 4).map(function (p) {
      var d = km ? Math.round(p[0] * km) + ' km' : Math.round(p[0]) + ' px';
      return '<li><a href="#" data-focus="' + esc(p[1].id) + '">' + esc(catById[p[1].category].icon) + ' ' + esc(p[1].name) + '</a> <small>' + d + '</small></li>';
    }).join('') + '</ul></div>';
  }

  function hideMarker(id) {
    hiddenMarkers[id] = true; save(HIDDEN_KEY, hiddenMarkers); refresh();
    toast('Marcador oculto. Reative em “Camadas → todas”.');
  }

  /* Mostra/oculta cada marcador de acordo com categoria, zoom e ocultação manual */
  function refresh() {
    var z = map.getZoom();
    Object.keys(entries).forEach(function (id) {
      var e = entries[id], g = catGroups[e.cat.id];
      var on = catEnabled[e.cat.id] && z >= (e.cat.minZoom == null ? cfg.minZoom : e.cat.minZoom) && !hiddenMarkers[id];
      if (on) g.pins.addLayer(e.layer); else g.pins.removeLayer(e.layer);

      if (e.area) { if (catEnabled[e.cat.id]) g.areas.addLayer(e.area); else g.areas.removeLayer(e.area); }
    });
    Object.keys(catGroups).forEach(function (cid) {
      var on = catEnabled[cid];
      var g = catGroups[cid];
      [g.areas, g.pins].forEach(function (grp) {
        if (on && !map.hasLayer(grp)) grp.addTo(map);
        if (!on && map.hasLayer(grp)) map.removeLayer(grp);
      });
    });
    // nomes dos pins aparecem a partir de um zoom por categoria (namesZoom)
    Object.keys(entries).forEach(function (id) {
      var e = entries[id], el = e.layer.getElement && e.layer.getElement();
      var nm = el && el.querySelector('.pin-name');
      if (nm) nm.style.display = z >= (e.cat.namesZoom == null ? 3 : e.cat.namesZoom) ? 'block' : 'none';
    });
  }

  function focusMarker(id, openPopup) {
    var e = entries[id]; if (!e) return;
    delete hiddenMarkers[id]; save(HIDDEN_KEY, hiddenMarkers);
    if (!catEnabled[e.cat.id]) { catEnabled[e.cat.id] = true; persistCats(); syncFilterBoxes(); }
    var minZ = e.cat.minZoom == null ? cfg.minZoom : e.cat.minZoom;
    var z = Math.max(map.getZoom(), minZ);
    z = Math.min(z, cfg.maxZoom);
    map.setView(e.layer.getLatLng(), z, { animate: true });
    refresh();
    if (openPopup !== false) { e.layer.openPopup(); setMarkerInHash(id); }
    var el = e.layer.getElement && e.layer.getElement();
    var pin = el && el.querySelector('.pin');
    if (pin) { pin.classList.add('highlight'); setTimeout(function () { pin.classList.remove('highlight'); }, 3200); }
  }

  /* ---------- filtros ---------- */
  function buildFilters() {
    var counts = {};
    markers.forEach(function (m) { counts[m.category] = (counts[m.category] || 0) + 1; });
    $('filters').innerHTML = cfg.categories.map(function (c) {
      return '<li><label><input type="checkbox" data-cat="' + esc(c.id) + '"' + (catEnabled[c.id] ? ' checked' : '') + '>' +
        '<span class="swatch" style="background:' + esc(c.color) + '"></span>' +
        '<span>' + esc(c.icon) + ' ' + esc(c.name) + '</span>' +
        '<span class="count">' + (counts[c.id] || 0) + '</span></label></li>';
    }).join('');
    $('filters').addEventListener('change', function (ev) {
      var cb = ev.target; if (!cb.dataset.cat) return;
      catEnabled[cb.dataset.cat] = cb.checked; persistCats(); refresh();
    });
    $('all-on').onclick = function () { setAllCats(true); hiddenMarkers = {}; save(HIDDEN_KEY, hiddenMarkers); refresh(); };
    $('all-off').onclick = function () { setAllCats(false); };
  }
  function setAllCats(v) {
    cfg.categories.forEach(function (c) { catEnabled[c.id] = v; });
    persistCats(); syncFilterBoxes(); refresh();
  }
  function syncFilterBoxes() {
    var boxes = document.querySelectorAll('#filters input');
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = !!catEnabled[boxes[i].dataset.cat];
  }
  function persistCats() {
    var h = {}; Object.keys(catEnabled).forEach(function (k) { if (!catEnabled[k]) h[k] = true; });
    save(CATS_KEY, h);
  }

  /* ---------- busca (sem dependências; ignora acentos) ---------- */
  function search(q) {
    q = norm(q).trim(); if (!q) return [];
    var out = [];
    markers.forEach(function (m) {
      if (!entries[m.id]) return;
      var name = norm(m.name), score = 0;
      if (name === q) score = 100;
      else if (name.indexOf(q) === 0) score = 80;
      else if (name.indexOf(q) > -1) score = 60;
      else if ((m.aliases || []).some(function (a) { return norm(a).indexOf(q) > -1; })) score = 50;
      else if ((m.docs || []).some(function (d) { return norm(d.title).indexOf(q) > -1; })) score = 40;
      else if (norm(m.description).indexOf(q) > -1) score = 20;
      if (score) out.push({ m: m, score: score });
    });
    out.sort(function (a, b) { return b.score - a.score || a.m.name.localeCompare(b.m.name); });
    return out.slice(0, 30).map(function (o) { return o.m; });
  }
  function bindSearch() {
    var input = $('search'), list = $('results'), active = -1;
    function render() {
      var res = search(input.value);
      active = -1;
      if (!input.value.trim()) { list.hidden = true; list.innerHTML = ''; return; }
      list.hidden = false;
      list.innerHTML = res.length ? res.map(function (m) {
        var c = catById[m.category];
        return '<li data-id="' + esc(m.id) + '"><span>' + esc(c.icon) + '</span><span>' + esc(m.name) +
               '</span><small>' + esc(c.name) + '</small></li>';
      }).join('') : '<li class="empty">Nada encontrado</li>';
    }
    function go(li) {
      if (!li || !li.dataset.id) return;
      focusMarker(li.dataset.id);
      if (window.innerWidth <= 720) document.body.classList.add('sidebar-closed');
    }
    input.addEventListener('input', render);
    input.addEventListener('keydown', function (ev) {
      var items = list.querySelectorAll('li[data-id]');
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault(); if (!items.length) return;
        active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        for (var i = 0; i < items.length; i++) items[i].classList.toggle('active', i === active);
        items[active].scrollIntoView({ block: 'nearest' });
      } else if (ev.key === 'Enter') { go(items[active >= 0 ? active : 0]); }
      else if (ev.key === 'Escape') { input.value = ''; render(); }
    });
    list.addEventListener('click', function (ev) { go(ev.target.closest('li')); });
  }

  /* ---------- UI geral ---------- */
  function bindUi() {
    $('sidebar-toggle').onclick = function () {
      document.body.classList.toggle('sidebar-closed');
      setTimeout(function () { map.invalidateSize(); }, 280);
    };
    if (window.innerWidth <= 720) document.body.classList.add('sidebar-closed');
    $('share').onclick = function () {
      writeHash(true);
      copy(location.href).then(function (ok) { toast(ok ? 'Link copiado!' : 'Copie o link na barra de endereço.'); });
    };
  }

  /* ---------- link permanente: #x=1200&y=800&z=-1&m=id ---------- */
  var hashTimer, currentMarker = null;
  function setMarkerInHash(id) { currentMarker = id; writeHash(); }
  function writeHash(now) {
    clearTimeout(hashTimer);
    var run = function () {
      var c = map.getCenter();
      var h = '#x=' + Math.round(c.lng) + '&y=' + Math.round(-c.lat) + '&z=' + map.getZoom() +
              (currentMarker ? '&m=' + encodeURIComponent(currentMarker) : '') +
              (api.extraHash ? api.extraHash() : '');
      history.replaceState(null, '', location.pathname + location.search + h);
    };
    if (now === true) run(); else hashTimer = setTimeout(run, 250);
  }
  function applyHash(initial) {
    var p = {};
    location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var i = kv.indexOf('='); if (i > 0) p[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
    });
    var x = parseFloat(p.x), y = parseFloat(p.y), z = parseFloat(p.z);
    if (isFinite(x) && isFinite(y) && isFinite(z)) {
      if (p.m && entries[p.m]) {   // garante que o pin do link esteja visível nesse zoom
        var mz = entries[p.m].cat.minZoom; if (mz != null) z = Math.max(z, mz);
      }
      map.setView(toLatLng(x, y), Math.max(cfg.minZoom, Math.min(cfg.maxZoom, z)), { animate: false });
    } else if (initial) {
      var v = cfg.initialView || { x: W / 2, y: H / 2, zoom: cfg.minZoom };
      map.setView(toLatLng(v.x, v.y), v.zoom, { animate: false });
    }
    if (p.m && entries[p.m]) {
      var e = entries[p.m];
      delete hiddenMarkers[p.m];
      catEnabled[e.cat.id] = true; syncFilterBoxes(); refresh();
      currentMarker = p.m;
      e.layer.openPopup();
    }
  }

  /* ---------- modo de edição: ?edit ---------- */
  function enableEditMode() {
    toast('Modo edição: clique no mapa para copiar x e y');
    map.on('click', function (ev) {
      var x = Math.round(ev.latlng.lng), y = Math.round(-ev.latlng.lat);
      var snippet = '"x": ' + x + ', "y": ' + y;
      copy(snippet).then(function (ok) {
        L.popup().setLatLng(ev.latlng)
          .setContent('<div class="popup"><b>' + snippet + '</b><div class="coords">' +
                      (ok ? 'copiado para a área de transferência' : 'copie manualmente') + '</div></div>')
          .openOn(map);
      });
    });
  }
})();

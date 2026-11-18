/* Ferramentas da interface: abas, barra de escala, régua, "meus pins", atalhos, ajuda, "perto daqui", copiar link. */
(function () {
  'use strict';

  var api, map, cfg, kmPx = 0.4795, maxNative = 5;
  var PINS_KEY = 'meumapa.myPins';

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function loadPins() { try { var v = JSON.parse(localStorage.getItem(PINS_KEY)); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function savePins(p) { try { localStorage.setItem(PINS_KEY, JSON.stringify(p)); } catch (e) { api.toast('Não foi possível salvar (armazenamento bloqueado).'); } }
  function fmtKm(km) { return km < 1 ? Math.round(km * 1000) + ' m' : (km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km).toLocaleString('pt-BR')) + ' km'; }
  function typing(ev) { var t = ev.target; return t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable); }

  /* ---------- abas ---------- */
  function showTab(name) {
    var tabs = document.querySelectorAll('#tabs button'), panes = document.querySelectorAll('.tab-pane');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].dataset.tab === name;
      tabs[i].classList.toggle('active', on); tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (var j = 0; j < panes.length; j++) panes[j].classList.toggle('active', panes[j].dataset.pane === name);
  }
  function initTabs() {
    $('tabs').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab);
    });
    if (!cfg.travel) $('tab-routes').hidden = true;
    api.showTab = showTab;
  }

  /* ---------- barra de escala (km) ---------- */
  function initScale() {
    if (!cfg.tiles) return;
    var Scale = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd: function () {
        var d = L.DomUtil.create('div', 'scalebar'); d.innerHTML = '<div class="bar"></div><span></span>';
        var bar = d.firstChild, lab = d.lastChild;
        function update() {
          var kpp = kmPx * Math.pow(2, maxNative - map.getZoom());          // km por pixel de tela
          var raw = kpp * 110, p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), n = raw / p;
          var nice = n >= 5 ? 5 : n >= 2 ? 2 : 1, km = nice * p;
          bar.style.width = Math.round(km / kpp) + 'px'; lab.textContent = fmtKm(km);
        }
        map.on('zoom zoomend', update); update();
        L.DomEvent.disableClickPropagation(d);
        return d;
      }
    });
    new Scale().addTo(map);
  }

  /* ---------- botões no mapa ---------- */
  function initMapButtons() {
    var C = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        var d = L.DomUtil.create('div', 'map-tools');
        [['📏', 'Medir distância (M)', toggleRuler], ['📍', 'Adicionar pin', startAddPin], ['❔', 'Ajuda (?)', toggleHelp]].forEach(function (b) {
          var a = L.DomUtil.create('button', ''); a.textContent = b[0]; a.title = b[1]; a.setAttribute('aria-label', b[1]);
          L.DomEvent.on(a, 'click', function (ev) { L.DomEvent.stop(ev); b[2](); });
          d.appendChild(a);
        });
        L.DomEvent.disableClickPropagation(d);
        return d;
      }
    });
    new C().addTo(map);
  }

  /* ---------- régua ---------- */
  var ruler = { on: false, pts: [], group: null };
  function setMode(cls, on) { $('map').classList.toggle(cls, !!on); }
  function toggleRuler() {
    ruler.on = !ruler.on;
    if (ruler.on) { stopAddPin(); ruler.group = ruler.group || L.layerGroup().addTo(map); }
    setMode('mode-draw', ruler.on);
    $('tool-ruler').innerHTML = (ruler.on ? '📏 Desligar régua' : '📏 Ligar régua') + ' <kbd>M</kbd>';
    if (!ruler.on) { clearRuler(); }
    else { drawRuler(); api.toast('Régua: clique no mapa para marcar pontos'); }
  }
  function clearRuler() { ruler.pts = []; if (ruler.group) ruler.group.clearLayers(); $('ruler-box').hidden = true; }
  function dist(a, b) { return Math.hypot(a.lng - b.lng, a.lat - b.lat) * kmPx; }
  function drawRuler() {
    ruler.group.clearLayers();
    var total = 0, box = $('ruler-box');
    ruler.pts.forEach(function (p, i) {
      if (i > 0) total += dist(ruler.pts[i - 1], p);
      var m = L.circleMarker(p, { radius: 5, color: '#000', weight: 2, fillColor: '#e0b341', fillOpacity: 1 }).addTo(ruler.group);
      if (i > 0) m.bindTooltip(fmtKm(total), { permanent: true, direction: 'top', offset: [0, -6], className: 'rl-tip' });
    });
    if (ruler.pts.length > 1) L.polyline(ruler.pts, { color: '#e0b341', weight: 3, dashArray: '6 6', interactive: false }).addTo(ruler.group);
    box.hidden = false;
    var t = cfg.travel, rows = '';
    if (t && total > 0) {
      rows = Object.keys(t.speeds).map(function (k) {
        var s = t.speeds[k], h = total / s.road, hpd = (t.hoursPerDay && t.hoursPerDay[k]) || 12, d = h / hpd;
        return '<li>' + api.esc(s.icon) + ' ' + api.esc(s.label) + ': <b>' + (d < 1 ? Math.round(h * 10) / 10 + ' h' : (Math.round(d * 10) / 10 + '').replace('.', ',') + ' dias') + '</b></li>';
      }).join('');
    }
    box.innerHTML = '<div class="rb-head"><b>📏 ' + fmtKm(total) + '</b><span>' + Math.max(0, ruler.pts.length - 1) + ' trecho(s)</span></div>' +
      (rows ? '<ul>' + rows + '</ul><small>Linha reta por estrada, ' + ((t.hoursPerDay && t.hoursPerDay.foot) || 12) + ' h/dia. Para o caminho real use Rotas.</small>' : '<small>Clique no mapa para começar.</small>') +
      '<div class="rb-actions"><button data-r="undo">↶ Desfazer</button><button data-r="clear">Limpar</button><button data-r="off">Sair</button></div>';
  }
  function initRuler() {
    map.on('click', function (ev) { if (!ruler.on) return; ruler.pts.push(ev.latlng); drawRuler(); });
    $('ruler-box').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-r]'); if (!b) return;
      if (b.dataset.r === 'undo') { ruler.pts.pop(); drawRuler(); }
      else if (b.dataset.r === 'clear') { ruler.pts = []; drawRuler(); }
      else toggleRuler();
    });
    L.DomEvent.disableClickPropagation($('ruler-box'));
    $('tool-ruler').onclick = toggleRuler;
  }

  /* ---------- meus pins ---------- */
  var mine = { pins: [], group: null, markers: {}, adding: false };
  function pinIcon(name) {
    return L.divIcon({
      className: '', iconSize: [0, 0],
      html: '<div class="pin mine" style="--c:#ff7ab8;--s:30px"><div class="bubble"><span>📍</span></div><span class="pin-name"></span></div>'
    });
  }
  function pinPopup(p) {
    var d = el('div', 'popup');
    d.appendChild(el('div', 'cat', '📍 Meu pin'));
    d.appendChild(el('h3', '', p.name));
    if (p.note) d.appendChild(el('p', '', p.note));
    var row = el('div', 'popup-actions');
    var del = el('button', '', '🗑 Excluir');
    del.onclick = function () { mine.pins = mine.pins.filter(function (x) { return x.id !== p.id; }); savePins(mine.pins); renderPins(); map.closePopup(); };
    var cp = el('button', '', '📋 Coordenadas');
    cp.onclick = function () { navigator.clipboard && navigator.clipboard.writeText('"x": ' + p.x + ', "y": ' + p.y); api.toast('Coordenadas copiadas'); };
    row.appendChild(del); row.appendChild(cp); d.appendChild(row);
    return d;
  }
  function renderPins() {
    mine.group.clearLayers(); mine.markers = {};
    mine.pins.forEach(function (p) {
      var m = L.marker(api.toLatLng(p.x, p.y), { icon: pinIcon(p.name), title: p.name, riseOnHover: true }).addTo(mine.group);
      m.bindPopup(function () { return pinPopup(p); }, { maxWidth: 300, minWidth: 220 });
      m.on('add', function () { var n = m.getElement() && m.getElement().querySelector('.pin-name'); if (n) n.textContent = p.name; });
      mine.markers[p.id] = m;
    });
    var ul = $('mypins'); ul.innerHTML = '';
    if (!mine.pins.length) { ul.appendChild(el('li', 'empty', 'Nenhum pin seu ainda.')); return; }
    mine.pins.forEach(function (p) {
      var li = el('li'), a = el('button', 'link', '📍 ' + p.name), x = el('button', 'link x', '✕');
      a.onclick = function () { map.setView(api.toLatLng(p.x, p.y), Math.max(map.getZoom(), 3)); mine.markers[p.id].openPopup(); };
      x.title = 'Excluir'; x.onclick = function () { mine.pins = mine.pins.filter(function (q) { return q.id !== p.id; }); savePins(mine.pins); renderPins(); };
      li.appendChild(a); li.appendChild(x); ul.appendChild(li);
    });
  }
  function addPinForm(latlng) {
    var x = Math.round(latlng.lng), y = Math.round(-latlng.lat);
    var d = el('div', 'popup pinform');
    d.appendChild(el('div', 'cat', '📍 Novo pin'));
    var name = el('input'); name.placeholder = 'Nome'; name.maxLength = 60;
    var note = el('textarea'); note.placeholder = 'Anotação (opcional)'; note.rows = 3; note.maxLength = 500;
    var row = el('div', 'popup-actions'), ok = el('button', '', 'Salvar'), no = el('button', '', 'Cancelar');
    function save() {
      var n = name.value.trim(); if (!n) { name.focus(); return; }
      mine.pins.push({ id: 'my-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), name: n, note: note.value.trim(), x: x, y: y });
      savePins(mine.pins); renderPins(); map.closePopup();
    }
    ok.onclick = save; no.onclick = function () { map.closePopup(); };
    name.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') save(); });
    row.appendChild(ok); row.appendChild(no);
    d.appendChild(name); d.appendChild(note); d.appendChild(row);
    L.popup({ minWidth: 220 }).setLatLng(latlng).setContent(d).openOn(map);
    setTimeout(function () { name.focus(); }, 50);
  }
  function startAddPin() {
    if (ruler.on) toggleRuler();
    mine.adding = true; setMode('mode-draw', true); api.toast('Clique no mapa para posicionar o pin (Esc cancela)');
  }
  function stopAddPin() { mine.adding = false; if (!ruler.on) setMode('mode-draw', false); }
  function initPins() {
    mine.pins = loadPins(); mine.group = L.layerGroup().addTo(map);
    renderPins();
    map.on('contextmenu', function (ev) { addPinForm(ev.latlng); });
    map.on('click', function (ev) { if (mine.adding) { stopAddPin(); addPinForm(ev.latlng); } });
    $('tool-addpin').onclick = startAddPin;
    $('tool-export').onclick = function () {
      var blob = new Blob([JSON.stringify(mine.pins, null, 2)], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'meus-pins.json';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    };
    $('tool-import').onchange = function () {
      var f = this.files && this.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          var arr = JSON.parse(r.result), n = 0;
          if (!Array.isArray(arr)) throw new Error('formato');
          arr.forEach(function (p) {
            if (!p || typeof p.name !== 'string' || !isFinite(p.x) || !isFinite(p.y)) return;
            var id = typeof p.id === 'string' ? p.id : 'my-' + Date.now().toString(36) + n;
            if (mine.pins.some(function (q) { return q.id === id; })) return;
            mine.pins.push({ id: id, name: p.name.slice(0, 60), note: String(p.note || '').slice(0, 500), x: +p.x, y: +p.y }); n++;
          });
          savePins(mine.pins); renderPins(); api.toast(n + ' pin(s) importado(s)');
        } catch (e) { api.toast('Arquivo inválido.'); }
      };
      r.readAsText(f); this.value = '';
    };
  }

  /* ---------- ajuda e atalhos ---------- */
  function toggleHelp() { $('help').hidden = !$('help').hidden; }
  function initHelp() {
    $('tool-help').onclick = toggleHelp;
    $('help-close').onclick = toggleHelp;
    $('help').addEventListener('click', function (ev) { if (ev.target === $('help')) toggleHelp(); });
    document.addEventListener('keydown', function (ev) {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ev.key === 'Escape') {
        if (!$('help').hidden) { toggleHelp(); return; }
        if (ruler.on) { toggleRuler(); return; }
        if (mine.adding) { stopAddPin(); return; }
        map.closePopup(); return;
      }
      if (typing(ev)) return;
      if (ev.key === '/') { ev.preventDefault(); document.body.classList.remove('sidebar-closed'); showTab('explore'); $('search').focus(); }
      else if (ev.key === 'm' || ev.key === 'M') toggleRuler();
      else if ((ev.key === 'r' || ev.key === 'R') && cfg.travel) { document.body.classList.remove('sidebar-closed'); showTab('routes'); $('rt-from').focus(); }
      else if (ev.key === '?') toggleHelp();
    });
  }

  /* ---------- cliques delegados dentro dos popups (captura: o Leaflet bloqueia a propagação) ---------- */
  function initPopupActions() {
    document.addEventListener('click', function (ev) {
      var f = ev.target.closest('[data-focus]');
      if (f) { ev.preventDefault(); api.focusMarker(f.dataset.focus); return; }
      var c = ev.target.closest('[data-copylink]');
      if (c) {
        ev.preventDefault();
        var e = api.entries[c.dataset.copylink]; if (!e) return;
        var url = location.origin + location.pathname + '#x=' + e.data.x + '&y=' + e.data.y + '&z=' + Math.max(3, map.getZoom()) + '&m=' + encodeURIComponent(e.data.id);
        (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(url) : Promise.reject()).then(
          function () { api.toast('Link do pin copiado!'); }, function () { api.toast('Copie o link na barra de endereço.'); });
      }
    }, true);
  }

  window.GuildaTools = {
    init: function (a) {
      api = a; map = api.map; cfg = api.cfg;
      kmPx = (cfg.travel && cfg.travel.kmPerPx) || kmPx; if (cfg.tiles) maxNative = cfg.tiles.unitZoom != null ? cfg.tiles.unitZoom : cfg.tiles.maxNativeZoom;
      initTabs(); initScale(); initMapButtons(); initRuler(); initPins(); initHelp(); initPopupActions();
    },
    fmtKm: fmtKm
  };
})();

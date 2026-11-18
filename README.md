# Guilda Map

Mapa interativo sobre uma imagem (mundo imaginário), feito com [Leaflet](https://leafletjs.com) — mesma base do witcher3map, sem build.

## Rodar localmente
```bash
python3 -m http.server 8000   # dentro desta pasta
# abra http://localhost:8000
```
(Abrir o `index.html` direto pelo arquivo não funciona: o navegador bloqueia o `fetch` dos JSON.)

## Trocar a imagem do mapa (tiles)
Imagens grandes são cortadas em "tiles" (pedaços de 256 px em vários zooms), como nos mapas de jogos.
```bash
pip install pillow
python3 tools/make_tiles.py caminho/da/imagem.png assets/tiles webp 80
```
O script imprime `width`, `height` e `maxNativeZoom`; copie esses valores para `data/config.json`
(`width`, `height`, `tiles.maxNativeZoom`). A imagem original (110 MB) não está no repositório — guarde-a em `source/` (já ignorada pelo git).
Para uma imagem pequena sem tiles, use `"image": "assets/mapa.jpg"` no lugar de `"tiles"`.

## Adicionar marcadores
Edite `data/markers.json`. Cada item:
```json
{
  "id": "cidade-exemplo",
  "category": "city",
  "name": "Nome",
  "x": 820, "y": 800,
  "description": "Texto do popup.",
  "aliases": ["outro nome"],
  "icon": "⚓",
  "docs": [{ "title": "Guia", "url": "docs/guia.md" }],
  "area": [[480,620],[720,480],[1050,560]]
}
```
- `x`/`y`: pixels da imagem original (8192×8192), origem no canto superior esquerdo.
- `category`: um `id` de `config.json` (country, duchy, capital, city, town, fort, ruin, temple, poi, pin).
- `description`: texto resumido exibido no popup.
- `image`: caminho/URL da imagem do popup (ex.: `assets/images/alvorada.jpg`); `imageRatio`: `"16:9"` (padrão) ou `"1:1"`. A imagem é recortada (cover) para caber na proporção; use ~800×450 (16:9) ou ~600×600 (1:1).
- `icon`, `aliases`, `docs`, `area` (polígono tracejado de fronteira) são opcionais.
- `docs[].url` pode ser um arquivo em `docs/`, Google Docs, Notion, PDF ou qualquer link.

**Descobrir coordenadas:** abra `http://localhost:8000/?edit` e clique no mapa — `"x": …, "y": …` é copiado para a área de transferência.

## Categorias
Em `data/config.json` → `categories`: nome, ícone, cor, `style` (`label-xl`/`label-lg` = texto no mapa, `pin` = alfinete) `minZoom` (zoom a partir do qual aparece), `namesZoom` (zoom a partir do qual o nome é exibido) e `size` (tamanho do pin).

## Recursos
Busca (ignora acentos; procura em nome, apelidos, títulos de documentos e descrição) · filtros por categoria · link permanente (`#x=…&y=…&z=…&m=id`) · botão de copiar link · botão direito/segurar para ocultar um pin · layout para celular · preferências salvas no navegador.

## Publicar
Qualquer hospedagem estática serve (GitHub Pages, Netlify, Cloudflare Pages): suba a pasta inteira.

## Notas
- Leaflet é carregado do CDN (unpkg). Para funcionar offline, baixe `leaflet.css`/`leaflet.js` (+ `images/`) para `js/vendor/` e troque os links no `index.html`.
- Imagens muito grandes (> ~8000 px) ficam pesadas. Nesse caso, o próximo passo é cortar em tiles (`gdal2tiles` ou `vips dzsave`) e usar `L.tileLayer`.

## Rotas e tempo de viagem

Painel **Rotas e viagens** (barra lateral, ou "Sair daqui / Chegar aqui" no popup de qualquer pin):

- Origem → destino a pé, a cavalo ou de carroça, combinados (opcionalmente) com **Ferroáurea**, **Aeronau**, **barco pequeno** (costa + rios) e **navio grande** (mar aberto).
- Tabela comparativa (3 modos × 5 combinações); clique numa célula para desenhar aquela rota. ★ marca a mais rápida.
- Rios: descer é mais rápido que subir (correnteza). O link compartilhável inclui a rota (`#r=origem,destino&b=modo&t=1&a=1&w=3`).

### Dados gerados (tools/)

| Arquivo | Gerado por | Conteúdo |
|---|---|---|
| `data/network.json` | `python3 tools/build_network.py IMAGEM` | estradas, trilhas e Ferroáurea extraídas da imagem |
| `data/water.json` | `python3 tools/build_water.py IMAGEM` | rios e rotas marítimas SIMULADAS (menor custo no mar) |

Requer numpy, scipy, scikit-image, opencv-python e Pillow. A imagem original (8192×8192) não vai no git.
Ajustes manuais: `tools/train_chains.json` (trajeto/estações da Ferroáurea), `tools/extra_links.json` (ligações forçadas na rede de terra).
Parâmetros de porto/faixa costeira estão no topo de `tools/build_water.py`; o relatório de portos sem rota sai no terminal.

### Velocidades e regras (`data/config.json` → `travel`)

Todas as velocidades (km/h), limite de 12 h de deslocamento por dia a pé/cavalo/carroça (o resto é descanso), esperas de embarque, horas de caminhada por dia, estações do Aeronau (`"capitals"` ou lista de ids) e correnteza dos rios são **valores provisórios** — ajuste à vontade. Escala: 0,4795 km/px (barra do mapa).

## Interface

- **Abas** na barra lateral: Explorar (camadas), Rotas e Ferramentas.
- **Escala em km** no canto inferior direito; botões no mapa para régua, novo pin e ajuda.
- **Régua** (`M`): mede em linha reta e estima tempo a pé/cavalo/carroça.
- **Meus pins**: botão direito (ou segurar no celular) no mapa; salvos no navegador, com exportar/importar JSON. (Ainda não entram no calculador de rotas.)
- **Popup dos pins**: "Perto daqui", "Copiar link", "Sair daqui / Chegar aqui".
- **Rotas**: copiar resumo, imprimir, link da rota e legenda das linhas.
- **Atalhos**: `/` buscar, `R` rotas, `M` régua, `Esc` fechar, `?` ajuda.

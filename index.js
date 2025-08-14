// index.js – Express API for PDF → SVG extraction via ConvertAPI
require('dotenv').config();
const express     = require('express');
const multer      = require('multer');
const fs          = require('fs').promises;
const ConvertAPI  = require('convertapi');

const convertapi = new ConvertAPI(process.env.CONVERT_API_SECRET);
const app    = express();
const upload = multer({ dest: '/tmp' });

// ───────────────── helpers ─────────────────

const toNum = (v) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// Parse full viewBox: minX minY width height
function getViewBox(svgText) {
  const m = svgText.match(/viewBox\s*=\s*"(\s*-?\d+(?:\.\d+)?)\s+(\s*-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  return {
    minX: parseFloat(m[1]),
    minY: parseFloat(m[2]),
    width: parseFloat(m[3]),
    height: parseFloat(m[4]),
  };
}

function stripXmlDecl(svgText) {
  return svgText.replace(/^\s*<\?xml[^>]*>\s*/i, '');
}

function parseRootAttrs(svgText) {
  const m = svgText.match(/<svg\b([^>]*)>/i);
  if (!m) return {};
  const attrStr = m[1] || '';
  const map = {};
  const attrRe = /([:\w.-]+)\s*=\s*("[^"]*"|'[^']*')/g;
  let mm;
  while ((mm = attrRe.exec(attrStr)) !== null) {
    const name = mm[1];
    const val  = mm[2].slice(1, -1);
    map[name] = val;
  }
  return map;
}

function extractInnerSvg(svgText) {
  const m = svgText.match(/<svg\b[^>]*>([\s\S]*?)<\/svg\s*>/i);
  if (!m) throw new Error('Input is not a valid SVG document');
  return m[1];
}

// Visual crop using correct translation that accounts for viewBox minX/minY
function cropSvgString(fullPageSvg, x1, y1, x2, y2) {
  const vb = getViewBox(fullPageSvg);
  if (!vb) throw new Error('viewBox not found on page SVG');

  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  if (!w || !h) throw new Error('Invalid crop box: zero width/height');

  const src   = stripXmlDecl(fullPageSvg);
  const attrs = parseRootAttrs(src);

  // Always include core namespaces; copy any xml:/xmlns: attrs without dupes
  const ns = {
    'xmlns': 'http://www.w3.org/2000/svg',
    'xmlns:xlink': 'http://www.w3.org/1999/xlink',
  };
  for (const [k, v] of Object.entries(attrs)) {
    const lk = k.toLowerCase();
    if (lk === 'xmlns' || lk.startsWith('xmlns:') || lk.startsWith('xml:')) {
      if (!ns[k]) ns[k] = v;
    }
  }
  if (!('xml:space' in ns)) ns['xml:space'] = 'preserve';

  const nsAttrStr = Object.entries(ns).map(([k, v]) => `${k}="${v}"`).join(' ');
  const inner = extractInnerSvg(src);

  // Offset must include original minX/minY
  const dx = -(vb.minX + x1);
  const dy = -(vb.minY + y1);

  return (
    `<svg ${nsAttrStr} viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">` +
      `<g transform="translate(${dx},${dy})">` +
        inner +
      `</g>` +
    `</svg>`
  );
}

// Raster→SVG mapping with optional scaling + origin flip (top-left → bottom-left)
function mapBoxToSvg({ x1, y1, x2, y2 }, origin, { rasterW, rasterH, svgW, svgH }) {
  const sx = rasterW && rasterW > 0 ? svgW / rasterW : 1;
  const sy = rasterH && rasterH > 0 ? svgH / rasterH : 1;

  let X1 = (x1 ?? 0) * sx;
  let X2 = (x2 ?? 0) * sx;
  let Y1 = (y1 ?? 0) * sy;
  let Y2 = (y2 ?? 0) * sy;

  if (X2 < X1) [X1, X2] = [X2, X1];
  if (Y2 < Y1) [Y1, Y2] = [Y2, Y1];

  if ((origin || 'pdf').toLowerCase() === 'topleft') {
    const Y1bl = svgH - Y2;
    const Y2bl = svgH - Y1;
    Y1 = Y1bl; Y2 = Y2bl;
  }

  return { x1: X1, y1: Y1, x2: X2, y2: Y2 };
}

async function renderFullPageSvgs(pdfTmpPath) {
  const result   = await convertapi.convert('svg', { File: pdfTmpPath }, 'pdf');
  const svgPaths = await result.saveFiles('/tmp');
  try {
    const svgPages = await Promise.all(svgPaths.map(p => fs.readFile(p, 'utf-8')));
    await Promise.all(svgPaths.map(p => fs.unlink(p).catch(() => {})));
    return svgPages;
  } catch (e) {
    await Promise.all(svgPaths.map(p => fs.unlink(p).catch(() => {})));
    throw e;
  }
}

// ───────────── routes ─────────────

// existing endpoint (unchanged behavior)
app.post('/extract-svg', upload.single('data'), async (req, res) => {
  let pdfIn;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded under field "data"' });
    const tmpIn = req.file.path;
    pdfIn = `${tmpIn}.pdf`;
    await fs.rename(tmpIn, pdfIn);

    const svgPages = await renderFullPageSvgs(pdfIn);
    await fs.unlink(pdfIn).catch(() => {});
    return res.json({ svgPages });
  } catch (err) {
    console.error('❌ /extract-svg failed:', err?.response?.data || err);
    return res.status(500).json({ error: err.message || 'Conversion failed' });
  }
});

// new: crop endpoint with origin+scaling+minX/minY fix
app.post('/extract-svg-crop', upload.any(), async (req, res) => {
  let pdfIn;
  try {
    // accept 'data' or 'pdf'
    const file =
      (Array.isArray(req.files) && req.files.find(f => f.fieldname === 'data')) ||
      (Array.isArray(req.files) && req.files.find(f => f.fieldname === 'pdf')) ||
      req.file || null;

    if (!file) return res.status(400).json({ error: 'No file uploaded under field "data" or "pdf"' });

    const page = toNum(req.body.page) ?? 1;
    let x1 = toNum(req.body.x1), y1 = toNum(req.body.y1),
        x2 = toNum(req.body.x2), y2 = toNum(req.body.y2);
    const coordsOrigin = (req.body.coordsOrigin || 'pdf').toLowerCase();

    const rasterW = toNum(req.body.rasterPageWidth);
    const rasterH = toNum(req.body.rasterPageHeight);

    if ([x1, y1, x2, y2].some(v => v === undefined)) {
      return res.status(400).json({ error: 'Missing or invalid x1,y1,x2,y2' });
    }
    if (!(x2 > x1 && y2 > y1)) {
      return res.status(400).json({ error: 'Invalid crop box: ensure x2>x1 and y2>y1' });
    }

    const tmpIn = file.path;
    pdfIn = `${tmpIn}.pdf`;
    await fs.rename(tmpIn, pdfIn);

    const svgPages = await renderFullPageSvgs(pdfIn);
    const pageIdx  = page - 1;
    if (pageIdx < 0 || pageIdx >= svgPages.length) {
      return res.status(400).json({ error: `Page ${page} out of range (has ${svgPages.length})` });
    }
    const fullPageSvg = svgPages[pageIdx];

    const vb = getViewBox(fullPageSvg);
    if (!vb) return res.status(400).json({ error: 'Could not read page viewBox' });

    // map into SVG units with correct origin
    const mapped = mapBoxToSvg(
      { x1, y1, x2, y2 },
      coordsOrigin,
      { rasterW, rasterH, svgW: vb.width, svgH: vb.height }
    );

    const cropped = cropSvgString(fullPageSvg, mapped.x1, mapped.y1, mapped.x2, mapped.y2);

    return res.json({
      svg: cropped,
      page,
      coords_in: { x1, y1, x2, y2, origin: coordsOrigin, rasterW, rasterH },
      svg_viewBox: vb,
      coords_svg: mapped
    });
  } catch (err) {
    console.error('❌ /extract-svg-crop failed:', err);
    return res.status(400).json({ error: String(err?.message || err) });
  } finally {
    if (pdfIn) { try { await fs.unlink(pdfIn); } catch (_) {} }
  }
});

// health
app.get('/', (_, res) => res.send('🟢 PDF-QA API running'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

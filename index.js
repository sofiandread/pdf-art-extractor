// index.js – Express API for PDF → SVG extraction via ConvertAPI
// -----------------------------------------------------------------------------
// Dependencies in package.json: express, multer, convertapi, dotenv
// -----------------------------------------------------------------------------

require('dotenv').config();
const express     = require('express');
const multer      = require('multer');
const fs          = require('fs').promises;
const ConvertAPI  = require('convertapi');

const convertapi = new ConvertAPI(process.env.CONVERT_API_SECRET);

const app    = express();
const upload = multer({ dest: '/tmp' }); // Multer temp dir

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

const toNum = (v) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function getPageSizeFromSvg(svgText) {
  // viewBox="minX minY width height"
  const m = svgText.match(
    /viewBox\s*=\s*"[^"]*?(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/i
  );
  if (!m) return null;
  const width  = parseFloat(m[3]);
  const height = parseFloat(m[4]);
  return { width, height };
}

function stripXmlDecl(svgText) {
  return svgText.replace(/^\s*<\?xml[^>]*>\s*/i, '');
}

function parseRootAttrs(svgText) {
  // Return a map of attributes on the outer <svg ...> tag
  const m = svgText.match(/<svg\b([^>]*)>/i);
  if (!m) return {};
  const attrStr = m[1] || '';
  const map = {};
  const attrRe = /([:\w.-]+)\s*=\s*("[^"]*"|'[^']*')/g;
  let mm;
  while ((mm = attrRe.exec(attrStr)) !== null) {
    const name = mm[1];
    const val  = mm[2].slice(1, -1); // drop quotes
    map[name] = val;
  }
  return map;
}

function extractInnerSvg(svgText) {
  const m = svgText.match(/<svg\b[^>]*>([\s\S]*?)<\/svg\s*>/i);
  if (!m) throw new Error('Input is not a valid SVG document');
  return m[1];
}

function cropSvgString(fullPageSvg, x1, y1, x2, y2) {
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  if (!w || !h) throw new Error('Invalid crop box: zero width/height');

  const src   = stripXmlDecl(fullPageSvg);
  const attrs = parseRootAttrs(src);             // original root attrs (may include xmlns/*)
  const inner = extractInnerSvg(src);

  // Always include core namespaces; copy over any other xml:/xmlns: attrs without dupes
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
  // Helpful default to avoid whitespace surprises
  if (!('xml:space' in ns)) ns['xml:space'] = 'preserve';

  const nsAttrStr = Object.entries(ns)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');

  // Visual crop: translate original content; viewBox defines the crop window
  return (
    `<svg ${nsAttrStr} viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">` +
      `<g transform="translate(${-x1},${-y1})">` +
        inner +
      `</g>` +
    `</svg>`
  );
}

function convertTopLeftToBottomLeft({ x1, y1, x2, y2 }, pageHeight) {
  return { x1, y1: pageHeight - y2, x2, y2: pageHeight - y1 };
}

async function renderFullPageSvgs(pdfTmpPath) {
  // Convert PDF → SVG (one per page), read contents, cleanup
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

// ───────────────────────────────────────────────────────────────────────────────
// Routes
// ───────────────────────────────────────────────────────────────────────────────

// (Existing) POST /extract-svg
// Body (multipart/form-data): field "data" must contain a PDF file
// Returns: { svgPages: ["<svg>…</svg>", …] }
app.post('/extract-svg', upload.single('data'), async (req, res) => {
  let pdfIn;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded under field "data"' });
    }
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

// (New) POST /extract-svg-crop
// Accepts file under "data" OR "pdf"; fields: page, x1, y1, x2, y2, coordsOrigin ("pdf"|"topleft")
// Returns JSON with the cropped SVG string and details
app.post('/extract-svg-crop', upload.any(), async (req, res) => {
  let pdfIn;
  try {
    // 1) Find uploaded file
    const file =
      (Array.isArray(req.files) && req.files.find(f => f.fieldname === 'data')) ||
      (Array.isArray(req.files) && req.files.find(f => f.fieldname === 'pdf')) ||
      req.file || null;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded under field "data" or "pdf"' });
    }

    // 2) Parse fields
    const page = toNum(req.body.page) ?? 1;
    let x1 = toNum(req.body.x1);
    let y1 = toNum(req.body.y1);
    let x2 = toNum(req.body.x2);
    let y2 = toNum(req.body.y2);
    const coordsOrigin = (req.body.coordsOrigin || 'pdf').toLowerCase();

    if ([x1, y1, x2, y2].some(v => v === undefined)) {
      return res.status(400).json({ error: 'Missing or invalid x1,y1,x2,y2' });
    }
    if (!(x2 > x1 && y2 > y1)) {
      return res.status(400).json({ error: 'Invalid crop box: ensure x2>x1 and y2>y1' });
    }

    // 3) Rename tmp upload to .pdf (helps ConvertAPI detect type)
    const tmpIn = file.path;
    pdfIn = `${tmpIn}.pdf`;
    await fs.rename(tmpIn, pdfIn);

    // 4) Render pages, pick page
    const svgPages = await renderFullPageSvgs(pdfIn);
    const pageIdx  = page - 1;
    if (pageIdx < 0 || pageIdx >= svgPages.length) {
      return res.status(400).json({ error: `Page ${page} out of range (document has ${svgPages.length})` });
    }
    const fullPageSvg = svgPages[pageIdx];

    // 5) Optional origin conversion
    if (coordsOrigin === 'topleft') {
      const size = getPageSizeFromSvg(fullPageSvg);
      if (!size) return res.status(400).json({ error: 'Could not read page size from SVG viewBox' });
      ({ x1, y1, x2, y2 } = convertTopLeftToBottomLeft({ x1, y1, x2, y2 }, size.height));
    }

    // 6) Crop
    const cropped = cropSvgString(fullPageSvg, x1, y1, x2, y2);

    // 7) Return JSON (keep as text so n8n can use it downstream)
    return res.json({
      svg: cropped,
      page,
      coords: { x1, y1, x2, y2 },
      origin: coordsOrigin,
    });
  } catch (err) {
    console.error('❌ /extract-svg-crop failed:', err);
    return res.status(400).json({ error: String(err?.message || err) });
  } finally {
    if (pdfIn) { try { await fs.unlink(pdfIn); } catch (_) {} }
  }
});

// Health check
app.get('/', (_, res) => res.send('🟢 PDF-QA API running'));

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

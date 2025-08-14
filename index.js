// index.js – Express API for PDF → SVG extraction via ConvertAPI
// -----------------------------------------------------------------------------
// Dependencies (already listed in package.json): express, multer, convertapi, dotenv
// -----------------------------------------------------------------------------

require('dotenv').config();
const express     = require('express');
const multer      = require('multer');
const fs          = require('fs').promises;
const ConvertAPI  = require('convertapi');

const convertapi = new ConvertAPI(process.env.CONVERT_API_SECRET);

const app    = express();
const upload = multer({ dest: '/tmp' }); // multer stores uploads as /tmp/<random>

// Helpful: parse numbers safely
function toNum(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// --- SVG helpers -------------------------------------------------------------

function getPageSizeFromSvg(svgText) {
  // Pull width/height from viewBox="minX minY width height"
  const m = svgText.match(/viewBox\s*=\s*"[^"]*?(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const width  = parseFloat(m[3]);
  const height = parseFloat(m[4]);
  return { width, height };
}

function stripXmlDecl(svgText) {
  return svgText.replace(/^\s*<\?xml[^>]*>\s*/i, '');
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

  const inner = extractInnerSvg(stripXmlDecl(fullPageSvg));

  // Visual crop: set viewBox to the box size and translate content so the box lands at (0,0)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">` +
    `<g transform="translate(${-x1},${-y1})">` +
    inner +
    `</g></svg>`
  );
}

function convertTopLeftToBottomLeft({ x1, y1, x2, y2 }, pageHeight) {
  // Incoming coords have origin at top-left (y grows downward).
  // PDF/SVG viewBox uses y downward too, but PDF logical "bottom-left" often used by upstream callers.
  // For top-left coords, flip using pageHeight:
  return {
    x1,
    y1: pageHeight - y2,
    x2,
    y2: pageHeight - y1,
  };
}

// --- PDF → SVG (ConvertAPI) --------------------------------------------------

async function renderFullPageSvgs(pdfTmpPath) {
  // Convert PDF → SVG (one SVG per page) and read file contents
  const result   = await convertapi.convert('svg', { File: pdfTmpPath }, 'pdf');
  const svgPaths = await result.saveFiles('/tmp');
  try {
    const svgPages = await Promise.all(svgPaths.map(p => fs.readFile(p, 'utf-8')));
    // Clean up generated SVG temp files (ignore failures)
    await Promise.all(svgPaths.map(p => fs.unlink(p).catch(() => {})));
    return svgPages;
  } catch (e) {
    // Best-effort cleanup, then bubble error
    await Promise.all(svgPaths.map(p => fs.unlink(p).catch(() => {})));
    throw e;
  }
}

// --- Routes ------------------------------------------------------------------

/**
 * (Existing) POST /extract-svg
 * Body (multipart/form-data): field "data" must contain a PDF file
 * Returns: { svgPages: ["<svg>…</svg>", …] }
 */
app.post('/extract-svg', upload.single('data'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded under field "data"' });
    }

    const tmpIn = req.file.path;        // e.g. /tmp/abc123
    const pdfIn = `${tmpIn}.pdf`;       // e.g. /tmp/abc123.pdf
    await fs.rename(tmpIn, pdfIn);

    const svgPages = await renderFullPageSvgs(pdfIn);

    // Clean up the uploaded PDF
    await fs.unlink(pdfIn).catch(() => {});

    return res.json({ svgPages });
  } catch (err) {
    console.error('❌ /extract-svg failed:', err.response?.data || err);
    return res.status(500).json({ error: err.message || 'Conversion failed' });
  }
});

/**
 * (New) POST /extract-svg-crop
 * Body (multipart/form-data):
 *   - "data": PDF file (required)
 *   - "page": 1-based page number (required)
 *   - "x1","y1","x2","y2": crop box in points (required)
 *   - "coordsOrigin": optional, "pdf" (default) or "topleft"
 *
 * Returns: { svg: "<svg>…</svg>", page: <int>, coords: {…}, origin: "pdf"|"topleft" }
 *
 * Notes:
 * - Visual crop (translate + viewBox). Elements outside the box remain but are off-canvas.
 * - Robust input validation + cleanup to avoid orphaned temp files.
 */
// BEFORE:
// app.post('/extract-svg-crop', upload.single('data'), async (req, res) => {

// AFTER: accept either 'data' or 'pdf'
app.post('/extract-svg-crop', upload.any(), async (req, res) => {
  let pdfIn;
  try {
    // Prefer 'data', else accept 'pdf'
    const file =
      (Array.isArray(req.files) && req.files.find(f => f.fieldname === 'data')) ||
      (Array.isArray(req.files) && req.files.find(f => f.fieldname === 'pdf')) ||
      req.file || null;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded under field "data" or "pdf"' });
    }

    // Multer gives us a temp path with no extension; add .pdf so ConvertAPI detects the type
    const tmpIn = file.path;
    pdfIn = `${tmpIn}.pdf`;
    await fs.rename(tmpIn, pdfIn);

    // ... keep your existing code from here (renderFullPageSvgs, page pick, coords, crop, etc.)


    // Render SVG pages and pick the requested page
    const svgPages = await renderFullPageSvgs(pdfIn);
    const pageIdx  = page - 1;
    if (pageIdx < 0 || pageIdx >= svgPages.length) {
      return res.status(400).json({ error: `Page ${page} out of range (document has ${svgPages.length} page(s))` });
    }
    const fullPageSvg = svgPages[pageIdx];

    // If coords are top-left origin, convert to bottom-left using page height
    if (coordsOrigin === 'topleft') {
      const size = getPageSizeFromSvg(fullPageSvg);
      if (!size) return res.status(400).json({ error: 'Could not read page size from SVG viewBox' });
      ({ x1, y1, x2, y2 } = convertTopLeftToBottomLeft({ x1, y1, x2, y2 }, size.height));
    }

    // Crop
    const cropped = cropSvgString(fullPageSvg, x1, y1, x2, y2);

    return res.json({
      svg: cropped,
      page,
      coords: { x1, y1, x2, y2 },
      origin: coordsOrigin === 'topleft' ? 'topleft' : 'pdf',
    });
  } catch (err) {
    console.error('❌ /extract-svg-crop failed:', err.response?.data || err);
     // If we ever want to return SVG directly:
     // res.type('image/svg+xml').send(cropped)
    return res.status(400).json({ error: err.message || 'Crop failed' });
  } finally {
    if (pdfIn) await fs.unlink(pdfIn).catch(() => {});
  }
});

// Simple health‑check
app.get('/', (_, res) => res.send('🟢 PDF-QA API running'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

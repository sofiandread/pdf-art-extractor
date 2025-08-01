// index.js – Express API for PDF → SVG extraction via ConvertAPI
// -----------------------------------------------------------------------------
// Dependencies (already listed in package.json): express, multer, convertapi, dotenv
// -----------------------------------------------------------------------------

require('dotenv').config();
const express   = require('express');
const multer    = require('multer');
const fs        = require('fs').promises;
const ConvertAPI = require('convertapi');

// Initialise ConvertAPI with your Railway env var
const convertapi = new ConvertAPI(process.env.CONVERT_API_SECRET);

const app    = express();
const upload = multer({ dest: '/tmp' }); // multer stores uploads as /tmp/<random>

/**
 * POST /extract-svg
 * Body (multipart/form-data): field "data" must contain a PDF file
 * Returns: { svgPages: ["<svg>…</svg>", …] }
 */
app.post('/extract-svg', upload.single('data'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded under field "data"' });
    }

    // Multer gives us a path with no .pdf extension. Rename so ConvertAPI detects file type.
    const tmpIn  = req.file.path;          // e.g. /tmp/abc123
    const pdfIn  = `${tmpIn}.pdf`;         // e.g. /tmp/abc123.pdf
    await fs.rename(tmpIn, pdfIn);

    // Convert PDF → SVG (one SVG per page)
    const result = await convertapi.convert('svg', { File: pdfIn }, 'pdf');

    // Save to /tmp then read into memory
    const svgPaths = await result.saveFiles('/tmp');
    const svgPages = await Promise.all(svgPaths.map(p => fs.readFile(p, 'utf-8')));

    // Clean up temp files (ignore failures)
    await Promise.all(svgPaths.map(p => fs.unlink(p).catch(() => {})));
    await fs.unlink(pdfIn).catch(() => {});

    return res.json({ svgPages });
  } catch (err) {
    console.error('❌ /extract-svg failed:', err.response?.data || err);
    return res.status(500).json({ error: err.message || 'Conversion failed' });
  }
});

// Simple health‑check
app.get('/', (_, res) => res.send('🟢 PDF-QA API running'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

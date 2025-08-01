// index.js – Express API for PDF → SVG extraction via ConvertAPI
// --------------------------------------------------------------
// Prerequisites (added to package.json):
//   "express", "multer", "convertapi", "dotenv" (optional but convenient)
// --------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const ConvertAPI = require('convertapi');

// Initialise ConvertAPI with the secret/token injected via Railway env vars
const convertapi = new ConvertAPI(process.env.CONVERT_API_SECRET);

const app = express();
// Store uploads on disk (ConvertAPI needs a path to read from)
const upload = multer({ dest: '/tmp' });

/**
 * POST /extract-svg
 * Body (multipart/form-data): { data: <PDF binary> }
 *   – we keep the field name **data** so you don’t have to touch your existing n8n node.
 * Response: { svgPages: ["<svg>…</svg>", "<svg>…</svg>", …] }
 */
app.post('/extract-svg', upload.single('data'), async (req, res) => {
  // Guard – must have a file attached
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded under field "data"' });
  }

  const pdfPath = req.file.path; // tmp path where Multer saved the PDF

  try {
    // ----- Convert the uploaded PDF to SVG via ConvertAPI -----
    //           dest fmt  params                     src fmt
    const result = await convertapi.convert('svg', { File: pdfPath });

    // ----- Save the resulting SVGs to /tmp and read them back -----
    const savedPaths = await result.saveFiles('/tmp');         // [ '/tmp/<uuid>-1.svg', … ]
    const svgPages   = await Promise.all(savedPaths.map(p => fs.readFile(p, 'utf-8')));

    // Clean up temp files (best‑effort)
    await Promise.all(savedPaths.map(p => fs.unlink(p).catch(() => {})));
    await fs.unlink(pdfPath).catch(() => {});

    return res.json({ svgPages });
  } catch (err) {
    console.error('❌ /extract-svg failed:', err);
    return res.status(500).json({ error: err.message || 'Conversion failed' });
  }
});

// Basic health‑check
app.get('/', (_, res) => res.send('🟢 PDF‑QA API running'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

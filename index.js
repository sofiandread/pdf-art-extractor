// index.js – Express API for PDF → SVG extraction via ConvertAPI
// --------------------------------------------------------------
// Prerequisites (already in package.json):
//   express, multer, convertapi, dotenv
// --------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const ConvertAPI = require('convertapi');

// Initialise ConvertAPI with the secret/token injected via Railway env vars
const convertapi = new ConvertAPI(process.env.CONVERT_API_SECRET);

const app = express();
// Store uploads on disk (ConvertAPI needs a path)
const upload = multer({ dest: '/tmp' });

/**
 * POST /extract-svg
 * Body (multipart/form-data): { data: <PDF binary> }
 * Response: { svgPages: ["<svg>…</svg>", …] }
 */
app.post('/extract-svg', upload.single('data'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded under field "data"' });
  }

  // Multer gives us a tmp path **without extension** (e.g. /tmp/abcd1234)
  const originalPath = req.file.path;
  const tmpPdfPath   = `${originalPath}.pdf`; // add explicit .pdf extension so ConvertAPI can detect type

  try {
    // Rename the file so it ends with .pdf (ConvertAPI relies on extension)
    await fs.rename(originalPath, tmpPdfPath);

    const result = await convertapi.convert('svg', { File: tmpPdfPath }, 'pdf');

    const savedPaths = await result.saveFiles('/tmp');
    const svgPages  = await Promise.all(savedPaths.map(p => fs.readFile(p, 'utf-8')));

    // Clean up
    await Promise.all(savedPaths.map(p => fs.unlink(p).catch(() => {})));
    await fs.unlink(tmpPdfPath).catch(() => {});

    return res.json({ svgPages });
  } catch (err) {
    console.error('❌ /extract-svg failed:', err.response?.data || err);
    return res.status(500).json({ error: err.message || 'Conversion failed' });
  }
});
  }

  const pdfPath = req.file.path; // temp PDF

  try {
    // Convert the uploaded PDF to SVG. FileName forces .pdf extension so ConvertAPI detects the type.
    const result = await convertapi.convert('svg', {
      File: pdfPath,
      FileName: 'upload.pdf'
    });

    // Save each page’s SVG to /tmp then read back into memory
    const savedPaths = await result.saveFiles('/tmp');
    const svgPages = await Promise.all(savedPaths.map(p => fs.readFile(p, 'utf-8')));

    // Clean temp files (best‑effort)
    await Promise.all(savedPaths.map(p => fs.unlink(p).catch(() => {})));
    await fs.unlink(pdfPath).catch(() => {});

    return res.json({ svgPages });
  } catch (err) {
    console.error('❌ /extract-svg failed:', err);
    return res.status(500).json({ error: err.message || 'Conversion failed' });
  }
});

// Health‑check route
app.get('/', (_, res) => res.send('🟢 PDF-QA API running'));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

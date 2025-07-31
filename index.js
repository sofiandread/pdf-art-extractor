const express = require('express');
const multer = require('multer');
const fileUpload = multer({ storage: multer.memoryStorage() });
const { PDFDocument } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.send('✅ Hello from the fresh API!');
});

// SVG extraction endpoint
app.post('/extract-svg', fileUpload.single('data'), async (req, res) => {
  try {
    const pdfBuffer = req.file.buffer;
    const pdfDoc = await PDFDocument.load(pdfBuffer);

    const pages = pdfDoc.getPages();
    const svgResults = [];

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const { width, height } = page.getSize();

      // Since pdf-lib does not support SVG extraction, we simulate it
      svgResults.push(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <text x="10" y="20">[Simulated SVG from page ${i + 1}]</text>
</svg>`);
    }

    res.json({ svgPages: svgResults });
  } catch (err) {
    console.error('Error extracting SVG:', err);
    res.status(500).json({ error: 'Failed to extract SVG' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

const express = require('express');
const app = express();

app.get('/', (_req, res) => {
  res.send('✅ Hello from the fresh API!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

const express = require('express');
const proxyRoutes = require('./routes/proxyRoutes');

const app = express();
const PORT = process.env.PORT || 4000;
 
app.use(express.json());

// Proxy routes
app.use('/', proxyRoutes);

app.listen(PORT, () => {
  console.log(`🚀 Caching Proxy running on port ${PORT}`);
});

 

 
 


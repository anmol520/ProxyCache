🚀 HTTP Caching Proxy Server (Node.js)

A production-style HTTP caching proxy server built using Node.js and Express, 
designed to forward requests to an origin server while caching only safe HTTP methods to ensure correctness and performance.

✨ Key Features

✅ Method-aware caching
Caches only GET requests
Forwards POST / PUT / DELETE / PATCH directly to origin
🚀 In-memory caching layer
🔁 Cache HIT / MISS detection
🧠 HTTP correctness-first design
📦 Clean controller–route architecture
🧪 Easy to test with Postman or curl

🧠 How It Works
Client
  ↓
Proxy Server (Express)
  ↓
Cache (GET only)
  ↓
Origin Server

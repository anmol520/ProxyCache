 const LRU = require('lru-cache');

const cache = new LRU({
    max: 100,             
    ttl: 1000 * 60 * 5,   
    allowStale: false
});

module.exports = cache;

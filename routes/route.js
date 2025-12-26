const express = require('express');
const router = express.Router();

const { HandleRequest } = require('../controllers/handleProxy');

 
router.all('*', HandleRequest);

module.exports = router;

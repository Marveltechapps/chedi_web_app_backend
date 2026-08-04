const express = require('express');
const path = require('path');
const fs = require('fs');
const { ApiError } = require('../lib/errors');

const router = express.Router();

function loadLegal() {
  const file = path.join(__dirname, '..', 'data', 'legal.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

router.get('/:doc', (req, res, next) => {
  try {
    const doc = req.params.doc;
    if (!['terms', 'privacy'].includes(doc)) {
      throw new ApiError(404, 'NOT_FOUND', 'Legal document not found');
    }
    const all = loadLegal();
    const content = all[doc];
    if (!content) throw new ApiError(404, 'NOT_FOUND', 'Legal document not found');
    res.json(content);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

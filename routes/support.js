const express = require('express');
const path = require('path');
const fs = require('fs');
const { optionalMember } = require('../middleware/auth');

const router = express.Router();

function loadSupport() {
  const file = path.join(__dirname, '..', 'data', 'support.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

router.get('/', optionalMember, async (_req, res, next) => {
  try {
    res.json(loadSupport());
  } catch (err) {
    next(err);
  }
});

module.exports = router;

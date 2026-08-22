const { getDB } = require('../config/db');
const { CROP_STAGE_LABELS } = require('./admin/constants');

const FALLBACK = [
  { name: 'Tomato', stage: 'Fruiting' },
  { name: 'Spinach', stage: 'Ready' },
  { name: 'Brinjal', stage: 'Flowering' },
  { name: 'Carrot', stage: 'Growing' },
];

async function growingNowForPlot(plotKey) {
  if (!plotKey) return FALLBACK;
  const db = getDB();
  const cultivation = await db.collection('cultivations').findOne({ plotKey });
  if (!cultivation?.cropKey) return FALLBACK;
  const crop = await db.collection('crops').findOne({ key: cultivation.cropKey });
  return [
    {
      name: crop?.name || cultivation.cropName || cultivation.cropKey,
      stage: CROP_STAGE_LABELS[cultivation.cropStage] || cultivation.cropStage,
    },
  ];
}

module.exports = { growingNowForPlot, FALLBACK };

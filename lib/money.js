/**
 * Money formatting helpers — backend is source of truth for amounts.
 */
function formatInr(amountInr) {
  const n = Number(amountInr) || 0;
  return `₹${n.toLocaleString('en-IN')}`;
}

function moneyFields(amountInr) {
  const amount = Math.round(Number(amountInr) || 0);
  return {
    amountInr: amount,
    amountFormatted: formatInr(amount),
    currency: 'INR',
  };
}

module.exports = { formatInr, moneyFields };

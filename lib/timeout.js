/**
 * Bound an async operation so it cannot hang the HTTP request forever.
 */
function withTimeout(promise, ms, message = 'Operation timed out') {
  const timeoutMs = Number(ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      err.code = 'TIMEOUT';
      err.status = 504;
      reject(err);
    }, timeoutMs);
  });

  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

module.exports = { withTimeout };

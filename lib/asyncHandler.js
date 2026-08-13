/**
 * Wrap async Express handlers so rejected promises reach error middleware
 * instead of becoming unhandled rejections (which can kill the process).
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      if (res.headersSent) {
        console.error('[http] error after response sent:', err && err.message ? err.message : err);
        return;
      }
      next(err);
    });
  };
}

module.exports = { asyncHandler };

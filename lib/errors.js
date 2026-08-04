/**
 * Structured API errors matching CHEDI_CSA_API_Contract §18.
 */
class ApiError extends Error {
  constructor(status, code, message, details = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function sendError(res, err, requestId) {
  const status = err.status || 500;
  const code = err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR');
  const message = err.message || 'Unexpected server error';
  const details = err.details || [];

  res.status(status).json({
    error: {
      code,
      message,
      details,
      requestId: requestId || undefined,
    },
  });
}

function errorHandler(err, req, res, _next) {
  if (process.env.NODE_ENV !== 'production' && statusOf(err) >= 500) {
    console.error(err);
  }
  sendError(res, err, req.requestId);
}

function statusOf(err) {
  return err.status || 500;
}

function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route for ${req.method} ${req.path}`,
      details: [],
      requestId: req.requestId,
    },
  });
}

module.exports = { ApiError, sendError, errorHandler, notFoundHandler };

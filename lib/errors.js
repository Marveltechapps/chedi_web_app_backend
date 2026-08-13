/**
 * Structured API errors matching CHEDI_CSA_API_Contract §18.
 * Client payload always includes success/message so the frontend never
 * depends on a dropped TCP connection to learn that something failed.
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

const PUBLIC_DB_MESSAGE = 'Database service temporarily unavailable';
const PUBLIC_DELIVERY_MESSAGE = 'Unable to send OTP. Please try again.';

function redactSecrets(text) {
  return String(text || '')
    .replace(/mongodb(\+srv)?:\/\/[^@\s]+@/gi, 'mongodb$1://***@')
    .replace(/(password|pass|secret|token|apikey|api_key|authorization)=[^&\s]+/gi, '$1=***');
}

function isMongoUnavailableError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  const msg = String(err.message || err);
  const code = err.code;
  return (
    name === 'MongoServerSelectionError' ||
    name === 'MongoNetworkError' ||
    name === 'MongoNetworkTimeoutError' ||
    name === 'MongoTimeoutError' ||
    name === 'MongoPoolClosedError' ||
    name === 'MongoNotConnectedError' ||
    code === 'DB_UNAVAILABLE' ||
    /Database not connected|database service temporarily unavailable/i.test(msg) ||
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|topology was destroyed|server selection timed out/i.test(
      msg
    ) ||
    /TLSV1_ALERT_INTERNAL_ERROR|tlsv1 alert internal error|SSL alert number 80/i.test(msg)
  );
}

function isOtpDeliveryError(err) {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || err);
  return (
    code === 'EMAIL_NOT_CONFIGURED' ||
    code === 'OTP_DELIVERY_FAILED' ||
    code === 'SMS_NOT_CONFIGURED' ||
    code === 'SMS_DELIVERY_FAILED' ||
    code === 'ECONNECTION' ||
    code === 'EAUTH' ||
    code === 'ETIMEDOUT' ||
    code === 'ETIMEOUT' ||
    code === 'TIMEOUT' ||
    code === 'ESOCKET' ||
    /Unable to deliver OTP|Email delivery is not configured|Unable to send OTP/i.test(msg) ||
    /smtp|nodemailer|connection timed out|greeting never received/i.test(msg)
  );
}

function sanitizeDetails(details) {
  if (!Array.isArray(details)) return [];
  return details.map((item) => {
    if (item == null || typeof item !== 'object') return { message: String(item) };
    const out = {};
    if (item.field != null) out.field = String(item.field);
    if (item.message != null) out.message = redactSecrets(item.message);
    if (item.retryAfterSeconds != null) out.retryAfterSeconds = item.retryAfterSeconds;
    if (item.attemptsRemaining != null) out.attemptsRemaining = item.attemptsRemaining;
    return out;
  });
}

function normalizeError(err) {
  if (!err) {
    return {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Unexpected server error',
      details: [],
    };
  }

  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return {
      status: err.status || 400,
      code: 'VALIDATION_ERROR',
      message: 'Invalid JSON body',
      details: [],
    };
  }

  if (isMongoUnavailableError(err)) {
    return {
      status: 503,
      code: 'DB_UNAVAILABLE',
      message: PUBLIC_DB_MESSAGE,
      details: [],
    };
  }

  if (isOtpDeliveryError(err)) {
    const status = err.status && err.status >= 500 ? err.status : 502;
    return {
      status: status === 504 ? 504 : 502,
      code: err.code === 'TIMEOUT' || err.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'OTP_DELIVERY_FAILED',
      message: PUBLIC_DELIVERY_MESSAGE,
      details: [],
    };
  }

  const status = Number(err.status) || 500;
  let message = redactSecrets(err.message || 'Unexpected server error');
  if (status >= 500) {
    // Never leak driver / SMTP internals to the client
    if (isMongoUnavailableError(err)) message = PUBLIC_DB_MESSAGE;
    else if (isOtpDeliveryError(err)) message = PUBLIC_DELIVERY_MESSAGE;
    else if (status === 500) message = 'Unexpected server error';
  }

  return {
    status,
    code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR'),
    message,
    details: sanitizeDetails(err.details),
  };
}

function sendError(res, err, requestId) {
  if (res.headersSent) return;
  const { status, code, message, details } = normalizeError(err);
  res.status(status).json({
    success: false,
    message,
    error: {
      code,
      message,
      details,
      requestId: requestId || undefined,
    },
  });
}

function errorHandler(err, req, res, _next) {
  if (res.headersSent) {
    console.error('[http] error after headers sent:', err && err.message ? err.message : err);
    return;
  }
  const normalized = normalizeError(err);
  if (process.env.NODE_ENV !== 'production' && normalized.status >= 500) {
    console.error('[http]', normalized.code, redactSecrets(err && err.message));
  }
  sendError(res, err, req.requestId);
}

function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    message: `No route for ${req.method} ${req.path}`,
    error: {
      code: 'NOT_FOUND',
      message: `No route for ${req.method} ${req.path}`,
      details: [],
      requestId: req.requestId,
    },
  });
}

module.exports = {
  ApiError,
  sendError,
  errorHandler,
  notFoundHandler,
  normalizeError,
  isMongoUnavailableError,
  isOtpDeliveryError,
  redactSecrets,
  PUBLIC_DB_MESSAGE,
  PUBLIC_DELIVERY_MESSAGE,
};

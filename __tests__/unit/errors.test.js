const {
  normalizeError,
  isMongoUnavailableError,
  isOtpDeliveryError,
  redactSecrets,
  PUBLIC_DB_MESSAGE,
  PUBLIC_DELIVERY_MESSAGE,
} = require('../../lib/errors');

describe('error mapping', () => {
  it('maps Mongo server selection failures to 503 without leaking internals', () => {
    const err = new Error('Server selection timed out. mongodb+srv://user:secret@cluster0.mongodb.net');
    err.name = 'MongoServerSelectionError';
    const mapped = normalizeError(err);
    expect(mapped.status).toBe(503);
    expect(mapped.message).toBe(PUBLIC_DB_MESSAGE);
    expect(mapped.message).not.toMatch(/secret/);
  });

  it('maps Atlas TLS alert 80 to 503', () => {
    const err = new Error('SSL alert number 80');
    expect(isMongoUnavailableError(err)).toBe(true);
    expect(normalizeError(err).status).toBe(503);
  });

  it('maps SMTP/SMS failures to 502 with a public message', () => {
    const err = new Error('Invalid login: 535-5.7.8 Username and Password not accepted');
    err.code = 'EAUTH';
    expect(isOtpDeliveryError(err)).toBe(true);
    const mapped = normalizeError(err);
    expect(mapped.status).toBe(502);
    expect(mapped.message).toBe(PUBLIC_DELIVERY_MESSAGE);
    expect(mapped.message).not.toMatch(/535/);
  });

  it('maps delivery timeout to a controlled 5xx', () => {
    const err = new Error('OTP email send timed out');
    err.code = 'TIMEOUT';
    err.status = 504;
    const mapped = normalizeError(err);
    expect(mapped.status).toBe(504);
    expect(mapped.message).toBe(PUBLIC_DELIVERY_MESSAGE);
  });

  it('redacts Mongo URIs', () => {
    const out = redactSecrets('failed mongodb+srv://user:hunter2@cluster0.mongodb.net/chedi');
    expect(out).not.toMatch(/hunter2/);
    expect(out).toMatch(/\*\*\*/);
  });
});

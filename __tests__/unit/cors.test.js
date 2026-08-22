const { createApp } = require('../../app');
const { isOriginAllowed, isChediOrigin, isLocalDevOrigin } = require('../../lib/cors');

describe('CORS policy', () => {
  const prev = process.env.CORS_ORIGIN;

  afterEach(() => {
    process.env.CORS_ORIGIN = prev;
  });

  it('allows listed origins, localhost Vite, and any https chedi.in host', () => {
    process.env.CORS_ORIGIN = 'https://webapp.chedi.in';
    expect(isOriginAllowed('https://webapp.chedi.in')).toBe(true);
    expect(isOriginAllowed('https://dashboard.chedi.in')).toBe(true);
    expect(isOriginAllowed('https://admin.chedi.in')).toBe(true);
    expect(isOriginAllowed('http://localhost:5173')).toBe(true);
    expect(isOriginAllowed('http://localhost:5174')).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:5173')).toBe(true);
    expect(isOriginAllowed('https://evil.example')).toBe(false);
    expect(isChediOrigin('https://dashboard.chedi.in')).toBe(true);
    expect(isLocalDevOrigin('http://localhost:5174')).toBe(true);
  });

  it('allows every origin when CORS_ORIGIN is *', () => {
    expect(isOriginAllowed('https://anything.example', '*')).toBe(true);
    expect(isOriginAllowed(undefined, '*')).toBe(true);
  });

  it('reflects production and local origins on HTTP responses', async () => {
    process.env.CORS_ORIGIN = 'https://webapp.chedi.in';
    const app = createApp();

    const prod = await requestGet(app, '/health', 'https://dashboard.chedi.in');
    expect(prod.status).toBe(200);
    expect(prod.headers['access-control-allow-origin']).toBe('https://dashboard.chedi.in');
    expect(prod.headers['access-control-allow-credentials']).toBe('true');

    const local = await requestOptions(app, '/api/admin/login', 'http://localhost:5173');
    expect(local.status).toBe(204);
    expect(local.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(String(local.headers['access-control-allow-headers'] || '').toLowerCase()).toContain(
      'authorization'
    );

    const blocked = await requestGet(app, '/health', 'https://evil.example');
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function requestGet(app, path, origin) {
  const server = await listen(app);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Origin: origin } });
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function requestOptions(app, path, origin) {
  const server = await listen(app);
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization,x-request-id,idempotency-key',
      },
    });
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

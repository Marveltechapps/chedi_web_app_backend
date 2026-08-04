const { createApp } = require('../../app');

describe('health', () => {
  it('returns ok without database', async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    server.close();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });
});

const { withTimeout } = require('../../lib/timeout');

describe('withTimeout', () => {
  it('resolves when the operation finishes in time', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000);
    expect(result).toBe('ok');
  });

  it('rejects when the operation exceeds the limit', async () => {
    await expect(
      withTimeout(new Promise(() => {}), 20, 'OTP email send timed out')
    ).rejects.toMatchObject({ code: 'TIMEOUT', status: 504 });
  });
});

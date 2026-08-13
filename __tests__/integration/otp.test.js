const request = require('supertest');
const { createApp } = require('../../app');
const otpService = require('../../services/otp.service');

jest.mock('../../services/otp.service', () => ({
  sendOtp: jest.fn(),
  verifyOtp: jest.fn(),
  otpLength: () => 4,
  allowDemoOtp: () => false,
  demoOtp: () => '1234',
}));

describe('POST /api/auth/otp', () => {
  const app = createApp();

  beforeEach(() => {
    otpService.sendOtp.mockReset();
  });

  it('returns 400 for an invalid email', async () => {
    const res = await request(app).post('/api/auth/otp').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/email/i);
  });

  it('returns 400 for an invalid phone number', async () => {
    const res = await request(app).post('/api/auth/otp').send({ phone: '123' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/phone/i);
  });

  it('returns 200 when OTP is sent', async () => {
    otpService.sendOtp.mockResolvedValue({
      resendAvailableInSeconds: 30,
      otpExpiresInSeconds: 300,
    });
    const res = await request(app).post('/api/auth/otp').send({ email: 'member@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('OTP sent successfully');
    expect(otpService.sendOtp).toHaveBeenCalled();
  });

  it('returns 503 when the database is unavailable', async () => {
    const err = new Error('Database service temporarily unavailable');
    err.status = 503;
    err.code = 'DB_UNAVAILABLE';
    otpService.sendOtp.mockRejectedValue(err);
    const res = await request(app).post('/api/auth/otp').send({ email: 'member@example.com' });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Database service temporarily unavailable');
  });

  it('returns 502 when the SMS/email provider fails', async () => {
    const err = new Error('Unable to send OTP. Please try again.');
    err.status = 502;
    err.code = 'OTP_DELIVERY_FAILED';
    otpService.sendOtp.mockRejectedValue(err);
    const res = await request(app).post('/api/auth/otp').send({ email: 'member@example.com' });
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Unable to send OTP. Please try again.');
  });
});

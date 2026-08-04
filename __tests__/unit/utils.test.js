const { formatInr, moneyFields } = require('../../lib/money');
const { normalizePhone, isValidIndianMobile, displayPhone } = require('../../lib/phone');
const { generateOtp } = require('../../utils/otpGenerator');
const { hashOtp, compareOtp } = require('../../utils/hash');

describe('money', () => {
  it('formats INR', () => {
    expect(formatInr(500)).toBe('₹500');
    expect(formatInr(250000)).toBe('₹2,50,000');
    expect(moneyFields(500).currency).toBe('INR');
  });
});

describe('phone', () => {
  it('normalizes Indian mobiles', () => {
    expect(normalizePhone('9840012345')).toBe('+919840012345');
    expect(normalizePhone('+91 98400 12345')).toBe('+919840012345');
    expect(isValidIndianMobile('+919840012345')).toBe(true);
    expect(displayPhone('+919840012345')).toBe('+91 98400 12345');
  });
});

describe('otp utils', () => {
  it('generates 4-digit codes', () => {
    const code = generateOtp(4);
    expect(code).toMatch(/^\d{4}$/);
  });

  it('hashes and compares', () => {
    const h = hashOtp('1234');
    expect(compareOtp('1234', h)).toBe(true);
    expect(compareOtp('0000', h)).toBe(false);
  });
});

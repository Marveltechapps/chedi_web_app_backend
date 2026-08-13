const express = require('express');
const { normalizeEmail, isValidEmail, displayEmail } = require('../lib/email');
const { normalizePhone, isValidIndianMobile } = require('../lib/phone');
const { ApiError } = require('../lib/errors');
const { asyncHandler } = require('../lib/asyncHandler');
const { findMemberByEmail, toMemberSummary } = require('../lib/members');
const otpService = require('../services/otp.service');
const jwtService = require('../services/jwt.service');
const { requireMember } = require('../middleware/auth');

const router = express.Router();

function otpCodePattern() {
  const len = otpService.otpLength();
  return new RegExp(`^\\d{${len}}$`);
}

function successOtpPayload(timing, email) {
  const payload = {
    success: true,
    message: 'OTP sent successfully',
    ok: true,
    email,
    emailDisplay: displayEmail(email),
    notice: `Code sent to ${email}.`,
    resendAvailableInSeconds: timing.resendAvailableInSeconds,
    otpExpiresInSeconds: timing.otpExpiresInSeconds,
  };
  if (otpService.allowDemoOtp()) {
    payload.demoOtp = otpService.demoOtp();
    payload.notice = `${payload.notice} (demo code ${payload.demoOtp})`;
  }
  return payload;
}

function validateOtpDestination(body) {
  const email = normalizeEmail(body?.email);
  const rawPhone = body?.phone || body?.mobile || body?.newPhone;

  if (!email && rawPhone != null && String(rawPhone).trim() !== '') {
    const phone = normalizePhone(String(rawPhone));
    if (!phone || !isValidIndianMobile(phone)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid phone number', [
        { field: 'phone', message: 'Invalid phone number' },
      ]);
    }
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid email address', [
      { field: 'email', message: 'Login OTP requires an email address' },
    ]);
  }

  if (!email || !isValidEmail(email)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid email address', [
      { field: 'email', message: 'Invalid email address' },
    ]);
  }

  return email;
}

router.post(
  '/otp',
  asyncHandler(async (req, res) => {
    const email = validateOtpDestination(req.body);

    const timing = await otpService.sendOtp({
      purpose: 'login',
      email,
      channel: 'email',
    });
    res.json(successOtpPayload(timing, email));
  })
);

router.post(
  '/otp/resend',
  asyncHandler(async (req, res) => {
    const email = validateOtpDestination(req.body);
    const timing = await otpService.sendOtp({
      purpose: 'login',
      email,
      channel: 'email',
    });
    const payload = successOtpPayload(timing, email);
    payload.notice = 'A new code has been sent to your email.';
    if (otpService.allowDemoOtp()) {
      payload.notice = `${payload.notice} (demo code ${payload.demoOtp})`;
    }
    res.json(payload);
  })
);

router.post(
  '/otp/verify',
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    if (!email || !isValidEmail(email)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid email address', [
        { field: 'email', message: 'Invalid email address' },
      ]);
    }
    const len = otpService.otpLength();
    if (!otpCodePattern().test(code)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `OTP must be ${len} digits`, [
        { field: 'code', message: `OTP must be ${len} digits` },
      ]);
    }

    await otpService.verifyOtp({ purpose: 'login', email, code });

    const member = await findMemberByEmail(email);
    if (!member || !member.isMember) {
      throw new ApiError(
        404,
        'MEMBER_NOT_FOUND',
        'No membership found for this email. Please join Farm Club first.'
      );
    }

    const summary = toMemberSummary(member);
    const tokens = await jwtService.issueTokens(summary);
    res.json({
      success: true,
      message: 'OTP verified',
      ok: true,
      ...tokens,
      member: summary,
    });
  })
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const refreshToken = req.body?.refreshToken;
    if (!refreshToken) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'refreshToken is required', [
        { field: 'refreshToken', message: 'Required' },
      ]);
    }
    const result = await jwtService.refreshTokens(refreshToken);
    res.json(result);
  })
);

router.post(
  '/logout',
  requireMember,
  asyncHandler(async (req, res) => {
    await jwtService.revokeRefreshToken(req.body?.refreshToken);
    res.json({ ok: true, success: true });
  })
);

router.post(
  '/sessions/revoke-all',
  requireMember,
  asyncHandler(async (req, res) => {
    const revokedCount = await jwtService.revokeAllSessions(req.member.id);
    res.json({ ok: true, success: true, revokedCount });
  })
);

module.exports = router;

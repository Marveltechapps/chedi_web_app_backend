const express = require('express');
const { normalizeEmail, isValidEmail, displayEmail } = require('../lib/email');
const { ApiError } = require('../lib/errors');
const { findMemberByEmail, toMemberSummary } = require('../lib/members');
const otpService = require('../services/otp.service');
const jwtService = require('../services/jwt.service');
const { requireMember } = require('../middleware/auth');

const router = express.Router();

function otpCodePattern() {
  const len = otpService.otpLength();
  return new RegExp(`^\\d{${len}}$`);
}

router.post('/otp', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !isValidEmail(email)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid email address', [
        { field: 'email', message: 'Invalid email address' },
      ]);
    }

    // Avoid enumeration: always succeed for valid format; OTP still sent
    const timing = await otpService.sendOtp({
      purpose: 'login',
      email,
      channel: 'email',
    });
    const payload = {
      ok: true,
      email,
      emailDisplay: displayEmail(email),
      notice: `Code sent to ${email}.`,
      resendAvailableInSeconds: timing.resendAvailableInSeconds,
      otpExpiresInSeconds: timing.otpExpiresInSeconds,
    };
    // Dev/demo only: expose OTP so local testing works without a real mailbox
    if (otpService.allowDemoOtp()) {
      payload.demoOtp = otpService.demoOtp();
      payload.notice = `${payload.notice} (demo code ${payload.demoOtp})`;
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.post('/otp/resend', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !isValidEmail(email)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid email address', [
        { field: 'email', message: 'Invalid email address' },
      ]);
    }
    const timing = await otpService.sendOtp({
      purpose: 'login',
      email,
      channel: 'email',
    });
    const payload = {
      ok: true,
      email,
      emailDisplay: displayEmail(email),
      notice: 'A new code has been sent to your email.',
      resendAvailableInSeconds: timing.resendAvailableInSeconds,
      otpExpiresInSeconds: timing.otpExpiresInSeconds,
    };
    if (otpService.allowDemoOtp()) {
      payload.demoOtp = otpService.demoOtp();
      payload.notice = `${payload.notice} (demo code ${payload.demoOtp})`;
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.post('/otp/verify', async (req, res, next) => {
  try {
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
      ok: true,
      ...tokens,
      member: summary,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const refreshToken = req.body?.refreshToken;
    if (!refreshToken) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'refreshToken is required', [
        { field: 'refreshToken', message: 'Required' },
      ]);
    }
    const result = await jwtService.refreshTokens(refreshToken);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireMember, async (req, res, next) => {
  try {
    await jwtService.revokeRefreshToken(req.body?.refreshToken);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/sessions/revoke-all', requireMember, async (req, res, next) => {
  try {
    const revokedCount = await jwtService.revokeAllSessions(req.member.id);
    res.json({ ok: true, revokedCount });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

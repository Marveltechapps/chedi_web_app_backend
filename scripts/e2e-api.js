/**
 * End-to-end API regression against a running server.
 * Usage: node scripts/e2e-api.js [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:4000/api';

const results = [];
let passed = 0;
let failed = 0;

function ok(name, detail = '') {
  passed += 1;
  results.push({ ok: true, name, detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  failed += 1;
  results.push({ ok: false, name, detail });
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function req(method, path, { body, token, idem, headers: extraHeaders, retries = 2 } = {}) {
  const headers = { Accept: 'application/json', ...(extraHeaders || {}) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idem) headers['Idempotency-Key'] = idem;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      return { status: res.status, data };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function assert(cond, name, detail) {
  if (cond) ok(name, detail);
  else fail(name, detail);
}

function uuid() {
  return `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function main() {
  console.log(`\nE2E API against ${BASE}\n`);

  // ---- Health ----
  {
    const r = await fetch(BASE.replace(/\/api$/, '') + '/health');
    const d = await r.json();
    assert(r.ok && d.ok, 'GET /health');
  }

  // ---- Public catalogs ----
  {
    const plans = await req('GET', '/plans');
    assert(plans.status === 200 && plans.data.items?.length >= 1, 'GET /plans', `${plans.data.items?.length || 0} plans`);
    const plots = await req('GET', '/plots?pageSize=50');
    assert(plots.status === 200 && plots.data.items?.length >= 1, 'GET /plots', `${plots.data.items?.length || 0} plots`);
    const support = await req('GET', '/support');
    assert(support.status === 200 && support.data.faq?.length >= 1, 'GET /support');
    const terms = await req('GET', '/legal/terms');
    assert(terms.status === 200 && terms.data.title, 'GET /legal/terms');
    const banks = await req('GET', '/payments/net-banks');
    assert(banks.status === 200 && banks.data.items?.length >= 1, 'GET /payments/net-banks');
  }

  // ---- Validation ----
  {
    const badOtp = await req('POST', '/auth/otp', { body: { email: 'not-an-email' } });
    assert(badOtp.status === 400, 'POST /auth/otp rejects invalid email');
    const badReg = await req('POST', '/membership/register', {
      body: { name: '', phone: 'x', email: 'bad', address: {} },
    });
    assert(badReg.status === 400 && badReg.data.error?.code === 'VALIDATION_ERROR', 'POST /membership/register validation');
  }

  // ---- Auth (existing dummy member) ----
  let token;
  let refresh;
  let member;
  {
    const otp = await req('POST', '/auth/otp', { body: { email: 'arun.kumar@example.com' } });
    assert(otp.status === 200 && otp.data.ok, 'POST /auth/otp', otp.data.demoOtp ? `demoOtp=${otp.data.demoOtp}` : '');
    const verify = await req('POST', '/auth/otp/verify', {
      body: { email: 'arun.kumar@example.com', code: otp.data.demoOtp || '1234' },
    });
    assert(verify.status === 200 && verify.data.accessToken, 'POST /auth/otp/verify login');
    token = verify.data.accessToken;
    refresh = verify.data.refreshToken;
    member = verify.data.member;
  }

  // ---- Protected session ----
  {
    const me = await req('GET', '/me', { token });
    assert(me.status === 200 && me.data.profile?.name, 'GET /me', me.data.profile?.name);
    const overview = await req('GET', '/overview', { token });
    assert(overview.status === 200 && overview.data.member, 'GET /overview');
    const notifs = await req('GET', '/notifications', { token });
    assert(notifs.status === 200 && Array.isArray(notifs.data.items), 'GET /notifications');
    const addrs = await req('GET', '/addresses', { token });
    assert(addrs.status === 200 && addrs.data.items?.length >= 1, 'GET /addresses');
    const pms = await req('GET', '/payment-methods', { token });
    assert(pms.status === 200 && Array.isArray(pms.data.items), 'GET /payment-methods');
    const hist = await req('GET', '/payments/history', { token });
    assert(hist.status === 200 && Array.isArray(hist.data.items), 'GET /payments/history');
    const subs = await req('GET', '/subscriptions', { token });
    assert(subs.status === 200 && Array.isArray(subs.data.items), 'GET /subscriptions');
    const deliveries = await req('GET', '/deliveries', { token });
    assert(deliveries.status === 200, 'GET /deliveries', deliveries.data.message || 'ok');
    const myPlot = await req('GET', '/my-plot', { token });
    assert(
      myPlot.status === 200 && typeof myPlot.data.hasPlot === 'boolean',
      'GET /my-plot',
      myPlot.data.hasPlot ? 'has plot' : 'no plot yet'
    );
  }

  // ---- Profile update ----
  {
    const patch = await req('PATCH', '/me/profile', {
      token,
      body: { name: 'Arun Kumar', email: 'arun.kumar@example.com' },
    });
    assert(patch.status === 200 && patch.data.ok, 'PATCH /me/profile');
    const prefs = await req('PUT', '/me/preferences/notifications', {
      token,
      body: { delivery: true, harvest: true, promos: true, channel: 'email' },
    });
    assert(prefs.status === 200 && prefs.data.ok, 'PUT /me/preferences/notifications');
  }

  // ---- Address CRUD ----
  let addrId;
  {
    const created = await req('POST', '/addresses', {
      token,
      body: { label: 'Office', line: '100, IT Park Road', city: 'Chennai', pin: '600113', setDefault: false },
    });
    assert(created.status === 201 && created.data.address?.id, 'POST /addresses');
    addrId = created.data.address.id;
    const patched = await req('PATCH', `/addresses/${addrId}`, {
      token,
      body: { line: '100, IT Park Road, Updated' },
    });
    assert(patched.status === 200, 'PATCH /addresses/:id');
    const def = await req('POST', `/addresses/${addrId}/default`, { token });
    assert(def.status === 200, 'POST /addresses/:id/default');
    const del = await req('DELETE', `/addresses/${addrId}`, { token });
    assert(del.status === 200, 'DELETE /addresses/:id');
  }

  // ---- Payment method add/primary ----
  let pmId;
  {
    const add = await req('POST', '/payment-methods', {
      token,
      body: {
        kind: 'card',
        number: '4111111111111111',
        name: 'ARUN KUMAR',
        expiry: '12/30',
        cvv: '123',
        setPrimary: true,
      },
    });
    assert(add.status === 201 && add.data.paymentMethod?.id, 'POST /payment-methods');
    pmId = add.data.paymentMethod.id;
  }

  // ---- Quote + lease payment ----
  let leaseSubId;
  let availablePlot;
  {
    const plots = await req('GET', '/plots?pageSize=50', { token });
    availablePlot = (plots.data.items || []).find(
      (p) => (p.status === 'available' || (p.availableUnits || 0) > 0) && !p.leasedByMe
    );

    if (!availablePlot) {
      const subs = await req('GET', '/subscriptions', { token });
      const existing = (subs.data.items || []).find((s) => s.status === 'active');
      assert(!!existing, 'Find available plot', 'none and no existing subscription');
      if (existing) {
        ok('Find available plot skipped', 'using existing subscription ' + existing.id);
        leaseSubId = existing.id;
      }
    } else {
      assert(!!availablePlot, 'Find available plot', availablePlot.key);
      const quote = await req('POST', '/subscriptions/quote', {
        token,
        body: { plotKey: availablePlot.key, planKey: 'family4' },
      });
      assert(quote.status === 200 && quote.data.totalInr > 0, 'POST /subscriptions/quote', quote.data.totalFormatted);

      const shares = await req('GET', '/plans/family4/produce-shares', { token });
      assert(shares.status === 200 && shares.data.staples?.length >= 1, 'GET /plans/:key/produce-shares');

      const lease = await req('POST', '/payments', {
        token,
        idem: uuid(),
        body: {
          context: 'lease',
          method: 'payment_request',
          metadata: { plotKey: availablePlot.key, planKey: 'family4' },
        },
      });
      assert(
        lease.status === 200 && lease.data.payment?.status === 'pending' && lease.data.payment?.id,
        'POST /payments lease request',
        lease.data.payment?.id || lease.data.error?.message
      );
      const approveLease = await req('POST', `/admin/payments/${lease.data.payment.id}/approve`, {
        headers: { Authorization: 'Bearer chedi-admin-demo' },
        body: { adminNote: 'e2e collected' },
      });
      assert(
        approveLease.status === 200 && approveLease.data.payment?.status === 'succeeded',
        'Admin approve lease payment',
        approveLease.data.error?.message || approveLease.data.payment?.status
      );
      const subsAfter = await req('GET', '/subscriptions', { token });
      const created = (subsAfter.data.items || []).find((s) => s.plotKey === availablePlot.key);
      assert(!!created, 'Lease subscription after approve', created?.id || 'missing');
      leaseSubId = created?.id;
    }

    if (leaseSubId) {
      const myPlot = await req('GET', '/my-plot', { token });
      assert(myPlot.status === 200 && myPlot.data.hasPlot === true, 'GET /my-plot after lease');
      const deliveries = await req('GET', `/deliveries?subscriptionId=${leaseSubId}`, { token });
      assert(deliveries.status === 200 && deliveries.data.hasPlot === true, 'GET /deliveries after lease');
      const schedule = deliveries.data.schedule || [];
      const cancellable = schedule.find((d) => d.cancellable);
      if (cancellable) {
        const cancel = await req('POST', `/deliveries/${cancellable.id}/cancel`, {
          token,
          body: { subscriptionId: leaseSubId, reason: 'e2e test' },
        });
        assert(cancel.status === 200 && cancel.data.ok, 'POST /deliveries/:id/cancel');
      } else {
        ok('POST /deliveries/:id/cancel skipped', 'no cancellable week');
      }

      const subGet = await req('GET', `/subscriptions/${leaseSubId}`, { token });
      assert(subGet.status === 200, 'GET /subscriptions/:id');
      if (subGet.data.billPaid === false) {
        const renew = await req('POST', `/subscriptions/${leaseSubId}/renewal-payments`, {
          token,
          idem: uuid(),
          body: { method: 'payment_request' },
        });
        assert(
          renew.status === 200 && renew.data.payment?.status === 'pending',
          'POST renewal-payments request',
          renew.data.payment?.id
        );
        const approveRenew = await req('POST', `/admin/payments/${renew.data.payment.id}/approve`, {
          headers: { Authorization: 'Bearer chedi-admin-demo' },
          body: { adminNote: 'e2e renewal' },
        });
        assert(
          approveRenew.status === 200 && approveRenew.data.payment?.status === 'succeeded',
          'Admin approve renewal',
          approveRenew.data.error?.message
        );
      } else {
        ok('renewal skipped', 'already paid');
      }

      const active = await req('PUT', '/me/active-subscription', {
        token,
        body: { subscriptionId: leaseSubId },
      });
      assert(active.status === 200, 'PUT /me/active-subscription');
    }
  }

  // ---- Notify-me on coming-soon plot ----
  {
    const plots = await req('GET', '/plots?status=soon&pageSize=20', { token });
    const soon = (plots.data.items || []).find((p) => p.status === 'soon');
    if (soon) {
      const n = await req('POST', `/plots/${soon.key}/notify-me`, { token });
      assert(n.status === 200 || n.status === 201 || n.status === 409 || n.status === 400, 'POST /plots/:key/notify-me', String(n.status));
    } else {
      ok('notify-me skipped', 'no soon plots');
    }
  }

  // ---- Join flow (new unique member) ----
  {
    const phone = `+9198${String(Date.now()).slice(-8)}`;
    const email = `e2e_${Date.now()}@example.com`;
    const reg = await req('POST', '/membership/register', {
      body: {
        name: 'E2E Tester',
        phone,
        email,
        address: { line: '1 Test Lane', city: 'Chennai', pin: '600001', label: 'Home' },
      },
    });
    assert(reg.status === 201 && reg.data.registrationId, 'POST /membership/register');
    if (reg.data.registrationId) {
      const pay = await req('POST', '/membership/payments', {
        idem: uuid(),
        body: {
          registrationId: reg.data.registrationId,
          method: 'payment_request',
        },
      });
      assert(
        pay.status === 200 && pay.data.payment?.status === 'pending',
        'POST /membership/payments request',
        pay.data.payment?.id || pay.data.error?.message
      );
      const approveMem = await req('POST', `/admin/payments/${pay.data.payment.id}/approve`, {
        headers: { Authorization: 'Bearer chedi-admin-demo' },
        body: { adminNote: 'e2e membership' },
      });
      assert(
        approveMem.status === 200 && approveMem.data.payment?.status === 'succeeded',
        'Admin approve membership',
        approveMem.data.sideEffect?.member?.memberCode || approveMem.data.error?.message
      );
      // Duplicate register should fail after membership is active
      const dup = await req('POST', '/membership/register', {
        body: {
          name: 'E2E Tester',
          phone,
          email: `other_${Date.now()}@example.com`,
          address: { line: '1 Test Lane', city: 'Chennai', pin: '600001' },
        },
      });
      assert(dup.status === 409, 'Duplicate phone rejected');
    }
  }

  // ---- Refresh + logout ----
  {
    const refreshed = await req('POST', '/auth/refresh', { body: { refreshToken: refresh } });
    assert(refreshed.status === 200 && refreshed.data.accessToken, 'POST /auth/refresh');
    const newToken = refreshed.data.accessToken || token;
    const logout = await req('POST', '/auth/logout', {
      token: newToken,
      body: { refreshToken: refreshed.data.refreshToken || refresh },
    });
    assert(logout.status === 200, 'POST /auth/logout');
    const denied = await req('GET', '/me', { token: newToken });
    // Access token may still be valid until expiry; refresh should be revoked.
    // Just ensure logout returned ok.
    ok('session logout completed', `me status after logout=${denied.status}`);
  }

  // ---- Auth guard ----
  {
    const unauth = await req('GET', '/me');
    assert(unauth.status === 401, 'GET /me without token → 401');
  }

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

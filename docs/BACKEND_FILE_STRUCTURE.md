# CHEDI CSA Backend — File Structure

Adapted from Mineral Bridge layout for the CHEDI CSA Member App API.

```
chediwebapp_backend/
├── server.js
├── app.js
├── package.json
├── jest.config.js
├── .env.example
├── config/
│   ├── db.js
│   └── redis.js
├── routes/
│   ├── auth.js
│   ├── membership.js
│   ├── me.js
│   ├── plots.js
│   ├── plans.js
│   ├── subscriptions.js
│   ├── payments.js
│   ├── payment_methods.js
│   ├── deliveries.js
│   ├── overview.js
│   ├── my_plot.js
│   ├── addresses.js
│   ├── notifications.js
│   ├── support.js
│   └── legal.js
├── lib/
│   ├── errors.js
│   ├── money.js
│   ├── phone.js
│   ├── members.js
│   ├── serializers.js
│   ├── idempotency.js
│   └── payments.js
├── middleware/
│   └── auth.js
├── services/
│   ├── jwt.service.js
│   └── otp.service.js
├── utils/
│   ├── hash.js
│   └── otpGenerator.js
├── data/
│   ├── plots.json
│   ├── plans.json
│   ├── support.json
│   └── legal.json
├── seed/
│   └── seed.js
├── scripts/
│   └── ensure-indexes.js
└── __tests__/
```

Base URL: `/api/v1` (also aliased at `/api`). Contract: `CHEDI_CSA_API_Contract.md`.

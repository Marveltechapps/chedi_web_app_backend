process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-min-32-chars!!';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-min-32-chars!';
process.env.ALLOW_DEMO_OTP = 'true';
process.env.DEMO_OTP = '1234';
process.env.OTP_LENGTH = '4';
process.env.MONGODB_DB = process.env.MONGODB_DB || 'chedi_csa_test';

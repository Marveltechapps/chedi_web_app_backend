module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  setupFiles: ['<rootDir>/__tests__/setup.js'],
  collectCoverageFrom: [
    'routes/**/*.js',
    'lib/**/*.js',
    'middleware/**/*.js',
    'services/**/*.js',
    'utils/**/*.js',
    'config/**/*.js',
  ],
  testTimeout: 30000,
};

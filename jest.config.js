/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  transform: {
    '^.+\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx', module: 'commonjs', esModuleInterop: true } }],
  },
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/$1' },
  testTimeout: 30_000,
};

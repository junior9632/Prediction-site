'use strict';

/**
 * Minimal, dependency-free ESLint flat config (ESLint 9).
 *
 * Deliberately correctness-only: these rules catch real bugs (undefined
 * variables, unused code, accidental globals, sloppy equality) without
 * imposing any formatting opinions on the existing style.
 *
 * Run via `npm run lint:js` — ESLint itself is fetched by npx in CI, so the
 * application keeps its zero-devDependency footprint.
 */

const NODE_GLOBALS = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  fetch: 'readonly',
  structuredClone: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  crypto: 'readonly',
};

const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  fetch: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  FormData: 'readonly',
  CustomEvent: 'readonly',
  IntersectionObserver: 'readonly',
  MutationObserver: 'readonly',
  matchMedia: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
};

const RULES = {
  // real bugs
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-cond-assign': 'error',
  'no-self-assign': 'error',
  'no-sparse-arrays': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-async-promise-executor': 'error',
  'no-compare-neg-zero': 'error',
  'no-fallthrough': 'error',
  'no-global-assign': 'error',
  'no-implicit-globals': 'error',
  'no-prototype-builtins': 'off',
  // sloppiness that becomes bugs
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  'no-throw-literal': 'error',
  'no-return-await': 'off', // intentional: `return await finalize(...)` keeps stack traces
  'require-atomic-updates': 'off',
};

module.exports = [
  {
    ignores: ['node_modules/**', 'logs/**', '.github/**'],
  },
  {
    files: ['server/**/*.js', 'scripts/**/*.js', 'tools/**/*.js', 'tests/**/*.js', 'server.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    // legacy `eslint-disable no-await-in-loop` comments predate this config
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: RULES,
  },
  {
    files: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 2019,
      sourceType: 'script',
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        Promise: 'readonly',
        console: 'readonly',
      },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: { ...RULES, 'no-implicit-globals': 'off' },
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2019, // the documented frontend floor: vanilla ES2019
      sourceType: 'script',
      globals: { ...BROWSER_GLOBALS, App: 'writable' },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: { ...RULES, 'no-implicit-globals': 'off' }, // page scripts attach to window via IIFEs
  },
];

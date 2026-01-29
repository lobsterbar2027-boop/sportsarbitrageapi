// bootstrap.js - Crypto polyfill for x402
// REQUIRED: Must load before main API

import { webcrypto } from 'crypto';

// Polyfill for environments that need it
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto;
}

// Now load main API
import('./api.js');

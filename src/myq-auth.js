'use strict';

const crypto = require('node:crypto');

const IDENTITY = 'https://partner-identity.myq-cloud.com';
const APP_VERSION = '5.243.1.73243';
const BRAND_ID = '1';
const USER_AGENT = 'sdk_gphone_x86/Android 11';
const CLIENT_ID = 'ANDROID_CGI_MYQ';
const REDIRECT_URI = 'com.myqops://android';
const SCOPE = 'MyQ_Residential offline_access';

// Obfuscated Firebase App Check profile used by the reference integration.
// This is shared integration metadata, not a user's MyQ credential.
const APP_CHECK_PREFIX = '26ce38db38df881debb4aa63859dfc9f73874291c4c7091ff400244f720366447283739722c99b1cf1b9e43bd8c3e6d2209204f3c0980c1dae552a760b722c1d18ce0daf3bc9a331';
const APP_CHECK_PROFILE = 'caade842d9a6b999558403ddb2a40071996457317d53021908d03ef67e98a843aa9f9c3fc7c7e1dd22d902a4c0c81510f905295b0c08624872f37cb379e8de4698beb167c490b98a';
const APP_CHECK_SUFFIX = '7b9653e3999c5147e355731238543f1865db209038c08800ecb8ac24878aa0eb729504f3919c0f19a8512517730b604e2f877ec02ecc8b16aee8e738de90b08d2f950ef3ccc55d10';
const APP_CHECK_MASK = '4bb749f64cade97398ddde0aeaf3d1eb16f43691f5fd3829cd341d764a3b567c';

function createAuthorizationRequest() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    acr_values: 'unified_flow:v1 brand:myq',
    client_id: CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ui_locales: 'en-US',
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    prompt: 'login',
    state,
  });
  return { url: `${IDENTITY}/connect/authorize?${query}`, verifier, state };
}

function readAppCheckProfile() {
  const mask = Buffer.from(APP_CHECK_MASK, 'hex');
  const encoded = Buffer.from(APP_CHECK_PREFIX + APP_CHECK_PROFILE + APP_CHECK_SUFFIX, 'hex');
  const decoded = Buffer.from([...encoded].map((value, index) => value ^ mask[index % mask.length]));
  const values = decoded.toString('ascii').split('\0');
  if (values.length !== 6 || values.some((value) => !value)) {
    throw new Error('The embedded MyQ App Check profile could not be decoded');
  }
  const [project, application, apiKey, debugToken, packageName, certificate] = values;
  return { project, application, apiKey, debugToken, packageName, certificate };
}

function extractAuthorizationCode(callbackUrl, expectedState) {
  let callback;
  try {
    callback = new URL(callbackUrl);
  } catch {
    throw new Error('That is not a valid MyQ callback URL');
  }
  if (callback.protocol !== 'com.myqops:' || callback.hostname !== 'android' || callback.pathname || callback.hash) {
    throw new Error('The URL is not the MyQ app callback. Copy the full com.myqops://android address from the browser.');
  }
  if (callback.searchParams.has('error')) throw new Error('MyQ sign-in was cancelled or rejected');
  const codes = callback.searchParams.getAll('code');
  const states = callback.searchParams.getAll('state');
  const issuers = callback.searchParams.getAll('iss');
  if (codes.length !== 1 || !codes[0] || states.length !== 1 || issuers.length !== 1) {
    throw new Error('The MyQ callback is incomplete; start a fresh sign-in and copy the entire callback URL.');
  }
  const receivedState = Buffer.from(states[0]);
  const expected = Buffer.from(expectedState);
  if (receivedState.length !== expected.length || !crypto.timingSafeEqual(receivedState, expected)) {
    throw new Error('The callback state did not match this sign-in. Start a fresh sign-in.');
  }
  if (issuers[0] !== IDENTITY) throw new Error('The callback issuer did not match MyQ Identity');
  return codes[0];
}

async function postJson(url, { body, headers = {} }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(`MyQ authentication request failed (${code}). No response credentials were displayed.`);
  }
  return payload;
}

async function mintAppCheckToken() {
  const profile = readAppCheckProfile();
  const endpoint = new URL(`https://firebaseappcheck.googleapis.com/v1/projects/${profile.project}/apps/${profile.application}:exchangeDebugToken`);
  endpoint.searchParams.set('key', profile.apiKey);
  const payload = await postJson(endpoint, {
    body: { debugToken: profile.debugToken },
    headers: { 'X-Android-Package': profile.packageName, 'X-Android-Cert': profile.certificate },
  });
  if (typeof payload.token !== 'string' || !payload.token) throw new Error('Firebase App Check did not return an authorization token');
  return payload.token;
}

async function exchangeAuthorizationCode(callbackUrl, { state, verifier }) {
  const code = extractAuthorizationCode(callbackUrl, state);
  const appCheckToken = await mintAppCheckToken();
  const form = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: SCOPE,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  const response = await fetch(`${IDENTITY}/connect/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'App-Version': APP_VERSION,
      BrandId: BRAND_ID,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
      'Firebase-AppCheck-Token': appCheckToken,
    },
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(`MyQ token exchange failed (${code}). The sign-in code may have expired; start a fresh sign-in.`);
  }
  if (typeof payload.refresh_token !== 'string' || !payload.refresh_token) {
    throw new Error('MyQ returned no refresh token. Start a new sign-in and check whether MyQ changed its authorization flow.');
  }
  return payload.refresh_token;
}

module.exports = { createAuthorizationRequest, exchangeAuthorizationCode, extractAuthorizationCode, readAppCheckProfile };


#!/usr/bin/env node
'use strict';

const { createAuthorizationRequest, exchangeAuthorizationCode } = require('../src/myq-auth');

async function readCallbackUrl() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Run this command in an interactive terminal so the one-time callback URL can be entered without echo.');
  }
  process.stderr.write('\nPaste the full com.myqops://android callback URL (input is hidden):\n');
  const input = process.stdin;
  input.setEncoding('utf8');
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') return finish(new Error('Sign-in cancelled'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else value += character;
      }
    };
    input.on('data', onData);
  });
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 20) {
    throw new Error('Node.js 20 or newer is required');
  }
  const authorization = createAuthorizationRequest();
  process.stdout.write('Sign in directly with MyQ in your browser. This tool never asks for or stores your MyQ password.\n\n');
  process.stdout.write('Open this MyQ authorization link:\n');
  process.stdout.write(`${authorization.url}\n\n`);
  process.stdout.write('Complete MyQ sign-in and any email/SMS verification in the browser.\n');
  process.stdout.write('When the browser redirects to com.myqops://android, copy the full address-bar URL.\n');
  const callbackUrl = await readCallbackUrl();
  const refreshToken = await exchangeAuthorizationCode(callbackUrl, authorization);
  process.stdout.write('\nMyQ refresh token (private; paste into the Homebridge plugin settings):\n');
  process.stdout.write(`${refreshToken}\n`);
  process.stdout.write('\nThis token can access your MyQ account. Keep it private; it was not saved to a file.\n');
}

main().catch((error) => {
  process.stderr.write(`MyQ sign-in failed: ${error.message}\n`);
  process.exitCode = 1;
});


import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../src/engine/controller.js';

// The real DeepSeek /responses gateway rejection for an oversized request body.
// It must classify as a distinct, recoverable `request_too_large` category — not
// the generic `backend_failure` that dead-ends a goal as `blocked`.
test('classifyFailure recognises a provider request-body-size rejection', () => {
  const real = classifyFailure(new Error('unexpected status 413 Payload Too Large: Failed to buffer the request body: length limit exceeded (request_id: 0c3d1156-d3fd-4307-baf1-ab565e1dbf6a), url: https://api.deepseek.com/responses'));
  assert.equal(real.category, 'request_too_large');
  // It is not retried blindly: the identical oversized body would 413 again.
  assert.equal(real.retryable, false);
  assert.equal(real.requiresInput, false);

  for (const message of [
    'HTTP 413 Request Entity Too Large',
    'request body too large for this endpoint',
    'Failed to buffer the request body: length limit exceeded',
  ]) assert.equal(classifyFailure(new Error(message)).category, 'request_too_large', message);
});

test('classifyFailure keeps other categories distinct from request_too_large', () => {
  assert.equal(classifyFailure(new Error('401 unauthorized: invalid api key')).category, 'authentication');
  assert.equal(classifyFailure(new Error('429 rate limit exceeded')).category, 'rate_limit');
  assert.equal(classifyFailure(new Error('backend timed out handling thread/resume')).category, 'timeout');
  assert.equal(classifyFailure(new Error('some other failure')).category, 'backend_failure');
});

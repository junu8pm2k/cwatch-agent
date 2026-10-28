import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { readFileSync } from 'node:fs';
import { readModelConfig } from "@cwatch/shared/config/models";
import { check } from './harness.ts';

const sample = { MODEL_PROVIDER: 'custom-provider', MODEL_ID: 'custom-model', API_KEY: 'test-key-only', BASE_URL: 'https://api.example.com/v1/' };
check('contract', 'model environment uses generic API_KEY and BASE_URL', () => {
  assert.deepEqual(readModelConfig(sample), { provider: 'custom-provider', modelId: 'custom-model', apiKey: 'test-key-only', baseUrl: 'https://api.example.com/v1' });
});
check('contract', 'missing model settings fail with variable name and no credential disclosure', () => {
  for (const name of ['MODEL_PROVIDER', 'MODEL_ID', 'API_KEY']) {
    const input = { ...sample, [name]: ' ' };
    assert.throws(() => readModelConfig(input), error => error instanceof Error && error.message.includes(name) && !error.message.includes(sample.API_KEY));
  }
});
check('contract', 'unsafe or request-path BASE_URL rejected without echoing its contents', () => {
  for (const baseUrl of ['not a URL', 'http://remote.example/v1', 'https://user:private-password@example.com/v1', 'https://api.example.com/v1?key=private-key', 'https://api.example.com/v1/chat/completions', 'https://api.example.com/v1/responses']) {
    assert.throws(() => readModelConfig({ ...sample, BASE_URL: baseUrl }), error => error instanceof Error && error.message.includes('BASE_URL') && !error.message.includes(baseUrl));
  }
});
check('contract', 'built-in provider can use generic key without overriding endpoint', () => {
  const config = readModelConfig({ ...sample, BASE_URL: '' }); assert.equal(config.baseUrl, undefined); assert.equal(config.apiKey, sample.API_KEY);
});
check('contract', 'env example contains supported variable names and no credential value', () => {
  const example = parseEnv(readFileSync('.env.example', 'utf8'));
  assert.deepEqual(Object.keys(example).sort(), ['API_KEY', 'BASE_URL', 'GITHUB_TOKEN', 'MODEL_ID', 'MODEL_PROVIDER', 'JUDGE_MODEL_PROVIDER', 'JUDGE_MODEL_ID', 'JUDGE_API_KEY', 'JUDGE_BASE_URL', 'WEB_NATIVE_PROVIDER', 'WEB_NATIVE_API_KEY', 'WEB_NATIVE_MODEL', 'WEB_NATIVE_BASE_URL', 'SEARCH_MCP_URL', 'SEARCH_MCP_TOKEN', 'API_SEARCH_URL', 'API_SEARCH_KEY', 'API_FETCH_URL', 'API_FETCH_KEY', 'GOOGLE_SEARCH_ENGINE_ID', 'PLATFORM_API_TOKEN'].sort()); assert.equal(example.API_KEY, ''); assert.equal(example.GITHUB_TOKEN, ''); assert.equal(example.WEB_NATIVE_API_KEY, ''); assert.equal(example.SEARCH_MCP_TOKEN, ''); assert.equal(example.API_SEARCH_KEY, ''); assert.equal(example.API_FETCH_KEY, ''); assert.equal(example.PLATFORM_API_TOKEN, '');
  for (const name of ['JUDGE_MODEL_PROVIDER', 'JUDGE_MODEL_ID', 'JUDGE_API_KEY', 'JUDGE_BASE_URL']) assert.equal(example[name], '');
});

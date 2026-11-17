import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {estimateToolPayloadTokens, estimateCodexRequestTokens} from '../dist/models/image-budget.js';
import {estimateSerializedTokens} from '../dist/models/context-budget.js';
import {createRequestBudget} from '../dist/models/request-budget.js';
import {boundedModelFetch} from '../dist/models/http-transport.js';

// Generated transport data at the original full-image regression scale. The
// journey separately verifies these bytes reach the selected model and ACK.
const rgb = Buffer.alloc(1024 * 1024 * 3);
let seed = 57;
for (let index = 0; index < rgb.length; index++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  rgb[index] = seed >>> 24;
}
const original = await sharp(rgb, {raw: {width: 1024, height: 1024, channels: 3}}).png({compressionLevel: 0}).toBuffer();
assert.equal(original.length, 3_151_914);
const data = original.toString('base64'), url = `data:image/png;base64,${data}`;
const image = {type: 'image', source: {type: 'base64', media_type: 'image/png', data}};
const inline = {inlineData: {mimeType: 'image/png', data}};
const window = 98_304, output = 8192;
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requests = {
  'OpenAI completions user image': ['openai-completions', {messages: [{role: 'user', content: [{type: 'image_url', image_url: {url}}]}]}],
  'OpenAI Responses user image without optional message type': ['openai-responses', {input: [{role: 'user', content: [{type: 'input_image', image_url: url}]}]}],
  'Responses function result image': ['openai-responses', {input: [{type: 'function_call_output', call_id: 'generated-call', output: [{type: 'input_image', image_url: url}]}]}],
  'Responses custom result image': ['openai-responses', {input: [{type: 'custom_tool_call_output', call_id: 'generated-call', output: [{type: 'input_image', image_url: url}]}]}],
  'Anthropic user image': ['anthropic-messages', {messages: [{role: 'user', content: [image]}]}],
  'Anthropic tool result image': ['anthropic-messages', {messages: [{role: 'user', content: [{type: 'tool_result', tool_use_id: 'generated-call', content: [image]}]}]}],
  'DeepSeek user image': ['deepseek', {messages: [{role: 'user', content: [image]}]}],
  'DeepSeek tool result image': ['deepseek', {messages: [{role: 'user', content: [{type: 'tool_result', tool_use_id: 'generated-call', content: [image]}]}]}],
  'Google user image': ['google-generative-ai', {contents: [{role: 'user', parts: [inline]}]}],
  'Google multimodal function response image': ['google-generative-ai', {contents: [{role: 'user', parts: [{functionResponse: {name: 'read_image', response: {output: 'Generated image metadata'}, parts: [inline]}}]}]}],
};

test('complete provider request budgets admit the original 3 MiB image only in formal image slots', async t => {
  for (const [name, [protocol, body]] of Object.entries(requests)) await t.test(name, () => {
    const budget = createRequestBudget(window, output, protocol), before = fingerprint(body);
    assert.ok(estimateSerializedTokens(body).tokens + output > window, 'encoded transport alone exceeds the unchanged window if miscounted as text');
    assert.equal(budget.fit(body), true, name);
    assert.ok(budget.measure(body) >= output + 10_000, 'each actual image keeps the existing conservative image reserve');
    assert.ok(budget.measure(body) < window);
    assert.equal(fingerprint(body), before, 'new image bytes are never rewritten to make the request fit');
  });
});

test('image-shaped captured content, unsupported roles and malformed slots retain the complete text estimate', async t => {
  const fake = {type: 'input_image', image_url: url};
  const bodies = {
    'ordinary user text with a data URI': {messages: [{role: 'user', content: url}]},
    'captured JSON text': {messages: [{role: 'user', content: [{type: 'text', text: JSON.stringify(fake)}]}]},
    'tool text': {messages: [{role: 'tool', content: url}]},
    'unsupported completions tool image': {messages: [{role: 'tool', content: [{type: 'image_url', image_url: {url}}]}]},
    'assistant image-shaped content': {messages: [{role: 'assistant', content: [image]}]},
    'nested captured messages': {metadata: {messages: [{role: 'user', content: [image]}]}},
    'tool schema example': {tools: [{name: 'generated', parameters: {example: fake}}]},
    'Google function response JSON': {contents: [{role: 'user', parts: [{functionResponse: {name: 'generated', response: {evidence: inline}}}]}]},
    'Google model image-shaped content': {contents: [{role: 'model', parts: [inline]}]},
    'Google text part with a pseudo inline image': {contents: [{role: 'user', parts: [{text: 'Generated captured text', ...inline}]}]},
    'Google text part with a pseudo function image': {contents: [{role: 'user', parts: [{text: 'Generated captured text', functionResponse: {name: 'generated', response: {}, parts: [inline]}}]}]},
    'Responses tool argument JSON': {input: [{type: 'function_call', arguments: JSON.stringify(fake)}]},
    'Responses result-shaped metadata without a call identity': {input: [{type: 'function_call_output', output: [fake]}]},
    'Responses assistant image-shaped content': {input: [{type: 'message', role: 'assistant', content: [fake]}]},
    'Responses nested metadata': {input: [{type: 'message', role: 'user', content: [{type: 'input_text', text: 'Generated capture', metadata: fake}]}]},
    'non-image MIME': {messages: [{role: 'user', content: [{type: 'image', source: {type: 'base64', media_type: 'text/plain', data}}]}]},
    'invalid base64 data': {messages: [{role: 'user', content: [{type: 'image', source: {type: 'base64', media_type: 'image/png', data: data + '!'}}]}]},
  };
  for (const [name, body] of Object.entries(bodies)) await t.test(name, () => {
    for (const protocol of ['openai-completions', 'openai-responses', 'anthropic-messages', 'deepseek', 'google-generative-ai']) {
      const budget = createRequestBudget(window, output, protocol), before = fingerprint(body);
      assert.ok(budget.measure(body) >= estimateSerializedTokens(body).tokens + output, protocol + ': all text bytes remain charged');
      assert.equal(budget.fit(body), false);
      assert.equal(fingerprint(body), before, 'an unsent captured result is not shortened or marked delivered');
    }
  });
});

test('formal image accounting leaves adjacent text and metadata fully charged', () => {
  const body = {messages: [{role: 'user', content: [{type: 'image_url', image_url: {url, generatedEvidence: data}}, {type: 'text', text: data}]}]};
  const budget = createRequestBudget(window, output, 'openai-completions');
  assert.ok(budget.measure(body) > 2 * Math.floor(data.length * 2 / 5));
  assert.equal(budget.fit(body), false, 'real image slots cannot exempt surrounding evidence');
  const payload = {text: url, images: [{mimeType: 'image/png', data}]};
  assert.ok(estimateToolPayloadTokens(payload) > window, 'the early Host allowance also retains image-shaped text');
  const captured = {text: JSON.stringify({images: [{mimeType: 'image/png', data}]})};
  assert.equal(estimateToolPayloadTokens(captured), estimateSerializedTokens(captured).tokens);
});

test('the unchanged output and per-image reserve can still reject a real image without replacing unsent bytes', () => {
  for (const [protocol, body] of Object.values(requests)) {
    const before = fingerprint(body), budget = createRequestBudget(18_000, output, protocol);
    assert.equal(budget.fit(body), false);
    assert.equal(fingerprint(body), before);
  }
  const native = {input: [{type: 'message', role: 'user', content: [{type: 'input_image', image_url: url}]}]};
  assert.equal(estimateCodexRequestTokens(native) + output, createRequestBudget(window, output, 'openai-responses').measure(native), 'native and HTTP Responses use the same image accounting');
  const twoImages = {messages: [{role: 'user', content: [{type: 'image_url', image_url: {url}}, {type: 'image_url', image_url: {url}}]}]};
  assert.equal(createRequestBudget(28_000, output, 'openai-completions').fit(twoImages), false, 'each transmitted occurrence retains its own image reserve');
});

test('request accounting uses only the selected protocol and never infers it from the body', () => {
  for (const [protocol, body] of Object.values(requests)) {
    for (const selected of [undefined, 'generated-unknown', protocol === 'openai-completions' ? 'anthropic-messages' : 'openai-completions']) {
      const budget = createRequestBudget(window, output, selected), before = fingerprint(body);
      assert.equal(budget.measure(body), estimateSerializedTokens(body).tokens + output);
      assert.equal(budget.fit(body), false);
      assert.equal(fingerprint(body), before);
    }
  }
});

test('the HTTP admission adapter forwards the selected protocol and charges extraBody pseudo slots before I/O', async t => {
  const body = requests['OpenAI completions user image'][1];
  for (const [name, protocol, input, extraBody, expected] of [
    ['selected completions image', 'openai-completions', body, {}, 200],
    ['unknown protocol', undefined, body, {}, 400],
    ['wrong selected protocol', 'anthropic-messages', body, {}, 400],
    ['extraBody cannot choose the protocol', 'anthropic-messages', body, {protocol: 'openai-completions'}, 400],
    ['extraBody wrong-protocol image', 'openai-completions', {messages: [{role: 'user', content: 'Generated request'}]}, requests['OpenAI Responses user image without optional message type'][1], 400],
    ['extraBody nested capture', 'openai-completions', {messages: [{role: 'user', content: 'Generated request'}]}, {metadata: body}, 400],
  ]) await t.test(name, async () => {
    const sent = [];
    const transport = boundedModelFetch(async (_input, init) => {sent.push(JSON.parse(init.body)); return new Response('{}');}, 'http://generated-context.invalid', 32 * 1024 * 1024, {baseUrl: 'http://127.0.0.1:9/v1', provider: 'custom', protocol, contextWindow: window, maxTokens: output, extraBody});
    const response = await transport('http://127.0.0.1:9/v1/chat/completions', {method: 'POST', body: JSON.stringify(input)});
    assert.equal(response.status, expected);
    await response.text();
    assert.equal(sent.length, expected === 200 ? 1 : 0, 'irreducible overflow is rejected before provider I/O');
    if (sent.length) assert.equal(fingerprint(sent[0]), fingerprint(body), 'all original image bytes reach the transport');
  });
});

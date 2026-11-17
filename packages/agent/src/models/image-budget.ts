import type {RuntimeToolPayload} from '../runtime/contracts.js';
import type {ModelProtocol} from '@mote/shared/models';
import {estimateSerializedTokens} from './context-budget.js';

// The pinned Codex 0.162.1 image estimator caps original-detail images at
// 10,000 patches (core/src/context_manager/history.rs). Reserve that ceiling
// even for cheaper default/high detail and the HTTP image transports. This is
// a conservative allowance, not a provider-exact tokenizer. Encoded bytes are
// transport, not text tokens. Keep it aligned with native/context_budget.rs.
const IMAGE_TOKEN_RESERVE = 10_000;

/** Early Host allowance; the runtime still checks its complete provider request. */
export function estimateToolPayloadTokens(payload: RuntimeToolPayload): number {
  if (!payload.images?.length) return estimateSerializedTokens(payload).tokens;
  const {images, ...body} = payload;
  return estimateSerializedTokens({...body, images: images.map(({mimeType}) => ({mimeType}))}).tokens + images.length * IMAGE_TOKEN_RESERVE;
}

type Row = Record<string, unknown>;
type Images = {characters: number; count: number};
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const imageMime = (value: unknown) => value === 'image/png' || value === 'image/jpeg' || value === 'image/webp';
const base64 = (value: string) => value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);

function imageUrl(value: unknown, images: Images) {
  images.count++;
  if (typeof value !== 'string') return;
  const separator = value.indexOf(',');
  if (/^data:image\/(?:png|jpeg|webp);base64,$/.test(value.slice(0, separator + 1)) && base64(value.slice(separator + 1))) images.characters += value.length;
}

function imageData(value: unknown, mime: unknown, images: Images) {
  if (!imageMime(mime) || typeof value !== 'string') return;
  images.count++;
  if (base64(value)) images.characters += value.length;
}

function responsesImages(body: unknown): Images {
  const images = {characters: 0, count: 0};
  for (const value of list(row(body).input)) {
    const item = row(value);
    const parts = item.role === 'user' && (item.type === undefined || item.type === 'message') ? item.content
      : (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') && typeof item.call_id === 'string' ? item.output : undefined;
    for (const value of list(parts)) {
      const part = row(value);
      if (part.type === 'input_image') imageUrl(part.image_url, images);
    }
  }
  return images;
}

function estimateImages(body: unknown, images: Images): number {
  // Subtract only validated ASCII image characters. Flooring the subtraction
  // retains conservative rounding and all actual JSON/framing overhead.
  return estimateSerializedTokens(body).tokens - Math.floor(images.characters * 2 / 5) + images.count * IMAGE_TOKEN_RESERVE;
}

/** Native and HTTP Responses share exactly the same typed image accounting. */
export function estimateCodexRequestTokens(body: unknown): number {
  return estimateImages(body, responsesImages(body));
}

/** The Host-selected protocol determines the only image slots inspected. Never
 * search captured text, tool schemas, response JSON or arbitrary metadata for
 * image-shaped values. Unknown transports retain the complete text estimate. */
export function estimateHttpRequestTokens(body: unknown, protocol?: ModelProtocol): number {
  if (protocol === 'openai-responses') return estimateCodexRequestTokens(body);
  const images = {characters: 0, count: 0};
  if (protocol === 'openai-completions') {
    for (const value of list(row(body).messages)) {
      const message = row(value);
      if (message.role !== 'user') continue;
      for (const value of list(message.content)) {
        const part = row(value);
        if (part.type === 'image_url') imageUrl(row(part.image_url).url, images);
      }
    }
  } else if (protocol === 'anthropic-messages' || protocol === 'deepseek') {
    const inspect = (value: unknown) => {
      const part = row(value), source = row(part.source);
      if (part.type === 'image' && source.type === 'base64') imageData(source.data, source.media_type, images);
    };
    for (const value of list(row(body).messages)) {
      const message = row(value);
      if (message.role !== 'user') continue;
      for (const value of list(message.content)) {
        const part = row(value);
        if (part.type === 'tool_result' && typeof part.tool_use_id === 'string') {
          for (const value of list(part.content)) inspect(value);
        } else inspect(part);
      }
    }
  } else if (protocol === 'google-generative-ai') {
    const inspect = (value: unknown) => {
      const part = row(value), inline = row(part.inlineData);
      if (part.text === undefined && part.functionCall === undefined && part.functionResponse === undefined && part.fileData === undefined) imageData(inline.data, inline.mimeType, images);
    };
    for (const value of list(row(body).contents)) {
      const content = row(value);
      if (content.role !== 'user') continue;
      for (const value of list(content.parts)) {
        const part = row(value), response = row(part.functionResponse);
        inspect(part);
        if (part.text === undefined && part.inlineData === undefined && part.functionCall === undefined && part.fileData === undefined && typeof response.name === 'string' && response.response && typeof response.response === 'object') {
          for (const value of list(response.parts)) inspect(value);
        }
      }
    }
  }
  return estimateImages(body, images);
}

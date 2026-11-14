import type {RuntimeToolPayload} from '../runtime/contracts.js';
import {estimateSerializedTokens} from './context-budget.js';

// The pinned Codex 0.162.1 image estimator caps original-detail images at
// 10,000 patches (core/src/context_manager/history.rs). Reserve that ceiling
// even for its cheaper default/high detail. Encoded bytes are transport, not
// text tokens. Keep this allowance aligned with native/context_budget.rs.
const IMAGE_TOKEN_RESERVE = 10_000;

/** Early Host allowance; the runtime still checks its complete provider request. */
export function estimateToolPayloadTokens(payload: RuntimeToolPayload): number {
  if (!payload.images?.length) return estimateSerializedTokens(payload).tokens;
  const {images, ...body} = payload;
  return estimateSerializedTokens({...body, images: images.map(({mimeType}) => ({mimeType}))}).tokens + images.length * IMAGE_TOKEN_RESERVE;
}

/** Only actual Responses image content slots qualify. Image-shaped captured
 * text, tool schemas and arbitrary metadata retain their full text estimate. */
export function estimateCodexRequestTokens(body: unknown): number {
  let imageCharacters = 0, images = 0;
  const input = (body as {input?: unknown} | null)?.input;
  if (Array.isArray(input)) for (const item of input) {
    const parts = item?.type === 'message' ? item.content
      : ['function_call_output', 'custom_tool_call_output'].includes(item?.type) ? item.output : undefined;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part?.type !== 'input_image') continue;
      images++;
      const url = part.image_url;
      if (typeof url === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) imageCharacters += url.length;
    }
  }
  // Subtract only validated ASCII image characters. Flooring the subtraction
  // retains conservative rounding and all actual JSON/framing overhead.
  return estimateSerializedTokens(body).tokens - Math.floor(imageCharacters * 2 / 5) + images * IMAGE_TOKEN_RESERVE;
}

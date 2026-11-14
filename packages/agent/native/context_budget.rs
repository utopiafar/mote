//! Mote's send-boundary budget for its private, single-run App Server process.
//! The state deliberately survives ModelClientSession/turn/transport replacement:
//! output repair, authentication, warmup and compaction share one recovery.
use crate::common::ResponsesApiRequest;
use crate::error::ApiError;
use codex_client::{Request, RequestBody, TransportError};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::sync::{Mutex, OnceLock};

pub const VERSION: &str = "mote-context-budget-v1";
pub const LIMIT: &str = "mote_native_processing_limit";

#[derive(Default)]
struct Budget {
    window: u64,
    recovered: bool,
    pending: bool,
    terminal: bool,
    // Only replacement notices, never captured content, are retained here.
    omitted: HashMap<String, (u64, String)>,
    fingerprints: RandomState,
}

static BUDGET: OnceLock<Option<Mutex<Budget>>> = OnceLock::new();

fn budget() -> Option<&'static Mutex<Budget>> {
    BUDGET.get_or_init(|| std::env::var("MOTE_NATIVE_CONTEXT_WINDOW").ok().map(|value| {
        Mutex::new(Budget { window: value.parse().unwrap_or(0), ..Budget::default() })
    })).as_ref()
}

pub fn enabled() -> bool { budget().is_some() }

/// An owner preference cannot expand the native model's actual input+output
/// window. Use the raw context window; its effective percentage already mixes
/// overhead and output and must not be subtracted again.
pub fn constrain_window(native_window: Option<i64>) -> Result<(), ApiError> {
    let Some(lock) = budget() else { return Ok(()); };
    let mut state = lock.lock().unwrap();
    let Some(window) = native_window.filter(|value| *value > 0) else {
        state.terminal = true;
        return Err(ApiError::ContextWindowExceeded);
    };
    state.window = state.window.min(window as u64);
    Ok(())
}

// Published model ceiling, NOT a request cap. Responses output includes reasoning.
// https://developers.openai.com/api/docs/models/gpt-5.4
// https://developers.openai.com/api/docs/models/gpt-6.1-terra
// https://developers.openai.com/api/reference/resources/responses/methods/create
// SIWC does not accept max_output_tokens. Reserve the whole documented ceiling;
// never substitute Host maxTokens or effective_context_window_percent for it.
fn output_ceiling(model: &str) -> Option<u64> {
    match model {
        "gpt-5.4" | "gpt-5.4-2026-03-05" => Some(128_000),
        "gpt-6.1-terra" => Some(128_000),
        _ => None,
    }
}

fn estimate(text: &str) -> u64 {
    let (mut ascii, mut bmp, mut astral) = (0u64, 0u64, 0u64);
    for c in text.chars() {
        match c as u32 { 0..=127 => ascii += 1, 128..=65535 => bmp += 1, _ => astral += 1 }
    }
    (ascii * 2).div_ceil(5) + (bmp * 3).div_ceil(2) + astral * 3
}

#[cfg(test)]
fn count(value: &Value) -> u64 { estimate(&value.to_string()) }

// Codex 0.162.1 core/src/context_manager/history.rs caps original-detail
// images at 10,000 patches. Reserve that ceiling for every image, including
// cheaper default/high detail; base64 transport bytes are not text tokens.
// Keep this allowance aligned with src/models/image-budget.ts.
const IMAGE_TOKEN_RESERVE: u64 = 10_000;

fn estimate_request(body: &Value, encoded: &str) -> u64 {
    let (mut image_characters, mut images) = (0u64, 0u64);
    for item in body.get("input").and_then(Value::as_array).into_iter().flatten() {
        let parts = match item.get("type").and_then(Value::as_str) {
            Some("message") => item.get("content"),
            Some("function_call_output" | "custom_tool_call_output") => item.get("output"),
            _ => None,
        };
        for part in parts.and_then(Value::as_array).into_iter().flatten() {
            if part.get("type").and_then(Value::as_str) != Some("input_image") { continue; }
            images += 1;
            if let Some(url) = part.get("image_url").and_then(Value::as_str)
                && let Some(data) = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"]
                    .iter().find_map(|prefix| url.strip_prefix(prefix))
                && !data.is_empty()
                && data.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
            { image_characters += url.len() as u64; }
        }
    }
    // Keep the actual wire framing and escaped text, including whitespace.
    // Floor the ASCII subtraction so rounding cannot undercount the remainder.
    estimate(encoded).saturating_sub(image_characters * 2 / 5).saturating_add(images * IMAGE_TOKEN_RESERVE)
}

fn output_key(item: &Value) -> Option<String> {
    let kind = item.get("type")?.as_str()?;
    if !matches!(kind, "function_call_output" | "custom_tool_call_output") { return None; }
    Some(format!("{kind}:{}", item.get("call_id")?.as_str()?))
}

impl Budget {
    fn fits(&self, body: &Value) -> bool {
        self.fits_encoded(body, &body.to_string())
    }

    fn fits_encoded(&self, body: &Value, encoded: &str) -> bool {
        let Some(reserve) = body.get("model").and_then(Value::as_str).and_then(output_ceiling) else { return false; };
        self.window > reserve && estimate_request(body, encoded).saturating_add(reserve) <= self.window
    }

    fn prepare(&mut self, body: &mut Value) -> Result<bool, ApiError> {
        if self.terminal { return Err(ApiError::ContextWindowExceeded); }
        if body.get("model").and_then(Value::as_str).and_then(output_ceiling).is_none() {
            self.terminal = true;
            tracing::warn!(code = "output_reserve_unavailable", "Mote native budget blocked request");
            return Err(ApiError::ContextWindowExceeded);
        }
        let Some(items) = body.get_mut("input").and_then(Value::as_array_mut) else {
            self.terminal = true;
            return Err(ApiError::ContextWindowExceeded);
        };
        let mut changed = false;
        for item in items {
            if let Some(key) = output_key(item)
                && let Some((fingerprint, notice)) = self.omitted.get(&key)
                && item.get("output").and_then(Value::as_str) != Some(notice) {
                let output = item.get("output").and_then(Value::as_str).ok_or(ApiError::ContextWindowExceeded)?;
                if self.fingerprints.hash_one(output) != *fingerprint {
                    // A reused call id cannot obtain another free reduction.
                    self.terminal = true;
                    return Err(ApiError::ContextWindowExceeded);
                }
                item["output"] = Value::String(notice.clone());
                changed = true;
            }
        }
        if self.fits(body) && !self.pending { return Ok(changed); }
        if self.recovered {
            self.terminal = true;
            return Err(ApiError::ContextWindowExceeded);
        }
        self.recovered = true;
        self.pending = false;
        let mut replacements = 0;
        for item in body["input"].as_array_mut().unwrap() {
            let Some(key) = output_key(item) else { continue; };
            // Preserve call/result pairing, instructions, owner inputs and assistant
            // outputs. Non-text results (including images) cannot be safely rewritten.
            let Some(output) = item.get("output").and_then(Value::as_str) else { continue; };
            let notice = json!({"budgetCoverage": {
                "truncated": true, "delivered": false, "originalBytes": output.len(),
                "reason": "Native context recovery omitted this tool result body. The tool already ran; do not repeat workspace actions. Use a smaller read-only page if more evidence is needed."
            }}).to_string();
            if output.len() <= notice.len() { continue; }
            let fingerprint = self.fingerprints.hash_one(output);
            item["output"] = Value::String(notice.clone());
            self.omitted.insert(key, (fingerprint, notice));
            replacements += 1;
        }
        tracing::info!(replacements, code = "context_recovery", "Mote native bounded recovery");
        if replacements == 0 || !self.fits(body) {
            self.terminal = true;
            return Err(ApiError::ContextWindowExceeded);
        }
        Ok(true)
    }
}

/// Called by the common client before deriving a WS delta/cache baseline.
pub fn prepare_request(request: &mut ResponsesApiRequest) -> Result<bool, ApiError> {
    let Some(lock) = budget() else { return Ok(false); };
    let mut value = serde_json::to_value(&*request).map_err(|_| ApiError::ContextWindowExceeded)?;
    let changed = lock.lock().unwrap().prepare(&mut value)?;
    if changed {
        request.input = serde_json::from_value(value["input"].take()).map_err(|_| ApiError::ContextWindowExceeded)?;
    }
    Ok(changed)
}

/// A provider context rejection may request precisely one retry of the model
/// step. No turn replay, tool execution, or remote compaction is initiated here.
pub fn request_recovery() -> bool {
    let Some(lock) = budget() else { return false; };
    let mut state = lock.lock().unwrap();
    if state.recovered || state.pending || state.terminal { return false; }
    state.pending = true;
    true
}

/// Native automatic compaction is the same one recovery, not a second budget.
pub fn begin_compaction() -> Result<(), ApiError> {
    let Some(lock) = budget() else { return Ok(()); };
    let mut state = lock.lock().unwrap();
    if state.recovered || state.pending || state.terminal {
        state.terminal = true;
        return Err(ApiError::ContextWindowExceeded);
    }
    state.recovered = true;
    tracing::info!(code = "context_compaction", "Mote native bounded recovery");
    Ok(())
}

pub fn check_json(body: &Value) -> Result<(), ApiError> {
    let Some(lock) = budget() else { return Ok(()); };
    let state = lock.lock().unwrap();
    if state.terminal || state.pending || !state.fits(body) { return Err(ApiError::ContextWindowExceeded); }
    Ok(())
}

fn check_encoded(encoded: &str) -> Result<(), ApiError> {
    let Some(lock) = budget() else { return Ok(()); };
    let body: Value = serde_json::from_str(encoded).map_err(|_| ApiError::ContextWindowExceeded)?;
    let state = lock.lock().unwrap();
    if state.terminal || state.pending || !state.fits_encoded(&body, encoded) {
        return Err(ApiError::ContextWindowExceeded);
    }
    Ok(())
}

/// Validate BOTH effective context and the final delta. A missing full context
/// is never inferred from the small previous_response_id payload.
pub fn check_websocket(text: &str, full: Option<&Value>) -> Result<(), ApiError> {
    if !enabled() { return Ok(()); }
    let wire: Value = serde_json::from_str(text).map_err(|_| ApiError::ContextWindowExceeded)?;
    if wire.get("type").and_then(Value::as_str) == Some("response.interrupt") { return Ok(()); }
    let full = full.ok_or(ApiError::ContextWindowExceeded)?;
    check_json(full)?;
    check_encoded(text)?;
    // Bind the supplied full context to this exact payload. All non-input
    // properties must match; the delta must be an actual suffix of full input.
    let mut effective = full.clone();
    let mut incremental = wire.clone();
    let full_input = effective["input"].take();
    let delta = incremental["input"].take();
    if effective != incremental { return Err(ApiError::ContextWindowExceeded); }
    let all = full_input.as_array().ok_or(ApiError::ContextWindowExceeded)?;
    let suffix = delta.as_array().ok_or(ApiError::ContextWindowExceeded)?;
    if !all.ends_with(suffix) { return Err(ApiError::ContextWindowExceeded); }
    Ok(())
}

/// Runs AFTER authentication on every physical HTTP send (including retries).
/// Compression is decoded for accounting; compressed byte size is never tokens.
pub fn check_http(request: &Request) -> Result<(), TransportError> {
    if !enabled() { return Ok(()); }
    let failed = || TransportError::Build(LIMIT.to_string());
    let raw = match request.body.as_ref() {
        Some(RequestBody::EncodedJson(body)) => body.as_bytes().to_vec(),
        Some(RequestBody::Json(body)) => body.to_string().into_bytes(),
        Some(RequestBody::Raw(body)) => body.to_vec(),
        None => return Err(failed()),
    };
    let raw = match request.headers.get(http::header::CONTENT_ENCODING).and_then(|v| v.to_str().ok()) {
        None => raw,
        Some("zstd") => zstd::stream::decode_all(std::io::Cursor::new(raw)).map_err(|_| failed())?,
        Some(_) => return Err(failed()),
    };
    let encoded = std::str::from_utf8(&raw).map_err(|_| failed())?;
    check_encoded(encoded).map_err(|_| failed())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terra_request() -> Value { json!({"model":"gpt-6.1-terra", "service_tier":"priority", "input":[
        {"type":"message", "role":"user", "content":"Reply with the single word ok."}
    ]}) }

    #[test]
    fn terra_small_request_and_fast_tier_do_not_consume_context_recovery() {
        for tier in [None, Some("priority")] {
            let mut request = terra_request();
            if tier.is_none() { request.as_object_mut().unwrap().remove("service_tier"); }
            let original = request.clone();
            let mut state = Budget {window:272_000, ..Budget::default()};
            assert!(!state.prepare(&mut request).unwrap());
            assert_eq!(request, original);
            assert!(!state.recovered);
            assert!(!state.terminal);
        }
    }

    #[test]
    fn terra_fast_requires_the_full_published_output_reserve_at_the_exact_boundary() {
        let request = terra_request();
        let exact = count(&request) + 128_000;
        let mut fitting = Budget {window:exact, ..Budget::default()};
        assert!(!fitting.prepare(&mut request.clone()).unwrap());
        for window in [exact - 1, 128_000] {
            let mut state = Budget {window, ..Budget::default()};
            let mut blocked = request.clone();
            assert!(matches!(state.prepare(&mut blocked), Err(ApiError::ContextWindowExceeded)));
            assert!(state.terminal);
            assert_eq!(blocked, request, "owner input must not be shortened to fit");
        }
        let padded = format!("     {}", request);
        assert!(!fitting.fits_encoded(&request, &padded), "final wire overhead still counts");
    }

    #[test]
    fn selected_image_bytes_do_not_consume_text_capacity_or_context_recovery() {
        let mut request = terra_request();
        request["input"][0]["content"] = json!([
            {"type":"input_text", "text":"Inspect the generated original."},
            {"type":"input_image", "image_url":format!("data:image/png;base64,{}", "e3t7".repeat(1024 * 1024))}
        ]);
        let original = request.clone();
        let mut state = Budget {window:272_000, ..Budget::default()};
        assert!(!state.prepare(&mut request).unwrap());
        assert_eq!(request, original, "never resize, omit or rewrite the selected image");
        assert!(!state.recovered);
        assert!(!state.terminal);
        let exact = estimate_request(&request, &request.to_string()) + 128_000;
        assert!(Budget {window:exact, ..Budget::default()}.fits(&request));
        assert!(!Budget {window:exact - 1, ..Budget::default()}.fits(&request), "image allowance and full output reserve remain mandatory");
        assert!(!Budget {window:exact, ..Budget::default()}.fits_encoded(&request, &format!("     {}", request)), "actual wire overhead still counts beside image data");
        request["input"][0]["content"].as_array_mut().unwrap().push(json!({"type":"input_image", "image_url":"data:image/png;base64,Z2VuZXJhdGVk"}));
        assert!(!Budget {window:exact, ..Budget::default()}.fits(&request), "each additional image consumes its own reserve");
    }

    #[test]
    fn image_shaped_text_and_metadata_cannot_bypass_the_text_budget() {
        let image = json!({"type":"input_image", "image_url":format!("data:image/png;base64,{}", "e3t7".repeat(1024 * 1024))});
        for field in ["text", "metadata", "tool_schema"] {
            let mut request = terra_request();
            match field {
                "text" => request["input"][0]["content"] = json!(image.to_string()),
                "metadata" => request["metadata"] = image.clone(),
                _ => request["tools"] = json!([{ "type":"function", "name":"generated", "parameters":image }]),
            }
            assert!(Budget {window:272_000, ..Budget::default()}.prepare(&mut request).is_err(), "{field} is ordinary serialized text, not an image slot");
        }
    }

    #[test]
    fn unknown_models_and_unverified_terra_aliases_cannot_borrow_its_output_reserve() {
        for model in ["generated-unknown-model", "gpt-6.1-terra-unverified", "gpt-6.1-terra-2026-11-14"] {
            let mut request = terra_request();
            request["model"] = json!(model);
            let mut state = Budget {window:1_050_000, ..Budget::default()};
            assert!(matches!(state.prepare(&mut request), Err(ApiError::ContextWindowExceeded)));
            assert!(state.terminal);
            request["model"] = json!("gpt-6.1-terra");
            assert!(state.prepare(&mut request).is_err(), "a rejected process cannot resume sending");
        }
    }

    fn body() -> Value { json!({"model":"gpt-5.4", "instructions":"Stable", "input":[
        {"type":"message", "role":"user", "content":"Owner input"},
        {"type":"function_call", "call_id":"one", "name":"read", "arguments":"{}"},
        {"type":"function_call_output", "call_id":"one", "output":"证🧪code".repeat(1200)}
    ]}) }

    #[test]
    fn tool_continuation_recovers_once_and_reapplies_notice_without_another_allowance() {
        let mut state = Budget {window:132_000, ..Budget::default()};
        let original = body();
        let mut request = original.clone();
        assert!(state.prepare(&mut request).unwrap());
        assert_eq!(request["input"][0], original["input"][0]);
        assert_eq!(request["input"][1], original["input"][1]);
        assert!(request["input"][2]["output"].as_str().unwrap().contains("budgetCoverage"));
        let mut continuation = original;
        assert!(state.prepare(&mut continuation).unwrap());
        assert_eq!(request, continuation);
        continuation["input"].as_array_mut().unwrap().push(json!({"type":"function_call_output", "call_id":"two", "output":"x".repeat(20_000)}));
        assert!(state.prepare(&mut continuation).is_err());
        assert!(state.terminal);
    }

    #[test]
    fn irreducible_owner_input_and_unknown_output_ceiling_fail_closed() {
        let mut request = json!({"model":"gpt-5.4","input":[{"type":"message","role":"user","content":"x".repeat(40_000)}]});
        let mut state = Budget {window:132_000, ..Budget::default()};
        assert!(state.prepare(&mut request).is_err());
        let mut unknown = body(); unknown["model"] = json!("unknown-model");
        assert!(Budget {window:1_000_000, ..Budget::default()}.prepare(&mut unknown).is_err());
        assert!(!Budget {window:128_000, ..Budget::default()}.fits(&body()));
    }

    #[test]
    fn provider_rejection_forces_one_reduction_even_when_estimate_fits() {
        let mut state = Budget {window:200_000, pending:true, ..Budget::default()};
        let mut request = body();
        assert!(state.prepare(&mut request).unwrap());
        assert!(state.recovered);
        state.pending = true;
        assert!(state.prepare(&mut request).is_err());
    }

    #[test]
    fn reused_call_id_with_different_content_cannot_receive_a_second_reduction() {
        let mut state = Budget {window:132_000, ..Budget::default()};
        assert!(state.prepare(&mut body()).unwrap());
        let mut reused = body();
        reused["input"][2]["output"] = json!("different".repeat(1200));
        assert!(state.prepare(&mut reused).is_err());
        assert!(state.terminal);
    }

    #[test]
    fn unicode_estimate_matches_mote_and_reserve_is_not_host_output_setting() {
        assert_eq!(estimate("abc证🧪"), 7);
        let mut request = body(); request["input"] = json!([]);
        let exact = count(&request) + 128_000;
        assert!(Budget {window:exact, ..Budget::default()}.fits(&request));
        assert!(!Budget {window:exact-1, ..Budget::default()}.fits(&request));
    }

    #[test]
    fn final_encoded_bytes_are_checked_without_reserializing_away_overhead() {
        let request = json!({"model":"gpt-5.4", "input":[]});
        let state = Budget {window:132_000, ..Budget::default()};
        assert!(state.fits(&request));
        let encoded = format!("{}{}", " ".repeat(12_000), request);
        assert_eq!(serde_json::from_str::<Value>(&encoded).unwrap(), request);
        assert!(!state.fits_encoded(&request, &encoded));
    }
}

#include <llama.h>
#include <mtmd.h>
#include <mtmd-helper.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
constexpr int kContext = 4096;
constexpr int kBatch = 128;
static double elapsed(Clock::time_point start) { return std::chrono::duration<double, std::milli>(Clock::now() - start).count(); }
static void quietLog(ggml_log_level, const char *, void *) {}

static std::vector<unsigned char> decodeBase64(const std::string &input) {
    if (input.size() > 12000000 || input.size() % 4 != 0) throw std::runtime_error("invalid image encoding");
    const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::vector<unsigned char> output;
    unsigned int buffer = 0; int bits = 0; bool padding = false;
    for (const char c : input) {
        if (c == '=') { padding = true; continue; }
        const auto index = alphabet.find(c);
        if (padding || index == std::string::npos) throw std::runtime_error("invalid image encoding");
        buffer = (buffer << 6) | static_cast<unsigned int>(index); bits += 6;
        if (bits >= 8) { bits -= 8; output.push_back(static_cast<unsigned char>((buffer >> bits) & 255)); }
    }
    return output;
}

static void requireFinite(const float *values, size_t count, bool logits) {
    if (!values || !count) throw std::runtime_error("empty model output");
    float low = std::numeric_limits<float>::infinity(), high = -low; size_t finite = 0;
    for (size_t i = 0; i < count; ++i) {
        const auto value = values[i];
        if (std::isnan(value) || (std::isinf(value) && (!logits || value > 0))) throw std::runtime_error("nonfinite model output");
        if (std::isfinite(value)) { low = std::min(low, value); high = std::max(high, value); finite++; }
    }
    if (!finite || (logits && high <= low)) throw std::runtime_error("invalid model output");
}

static std::string formatPrompt(const std::string &system, const std::string &user) {
    std::vector<llama_chat_message> messages = {{"system", system.c_str()}, {"user", user.c_str()}};
    std::vector<char> text(system.size() * 2 + user.size() * 2 + 1024);
    int size = llama_chat_apply_template("chatml", messages.data(), messages.size(), true, text.data(), text.size());
    if (size < 0) throw std::runtime_error("chat template failed");
    if (static_cast<size_t>(size) >= text.size()) {
        text.resize(size + 1);
        size = llama_chat_apply_template("chatml", messages.data(), messages.size(), true, text.data(), text.size());
    }
    if (size < 0) throw std::runtime_error("chat template failed");
    return std::string(text.data(), size) + "<think>\n\n</think>\n\n";
}

struct Engine {
    std::unique_ptr<llama_model, decltype(&llama_model_free)> model{nullptr, llama_model_free};
    std::unique_ptr<llama_context, decltype(&llama_free)> context{nullptr, llama_free};
    std::unique_ptr<mtmd_context, decltype(&mtmd_free)> vision{nullptr, mtmd_free};
    std::string key;
    double loadMs = 0;
    void load(const Json &request) {
        const auto modelPath = request.at("modelPath").get<std::string>();
        const auto projectorPath = request.at("projectorPath").get<std::string>();
        const int threads = request.at("threads").get<int>();
        if (threads < 1 || threads > 8 || modelPath.empty() || projectorPath.empty() || modelPath[0] != '/' || projectorPath[0] != '/') throw std::runtime_error("invalid model parameters");
        const auto nextKey = modelPath + "\n" + projectorPath + "\n" + std::to_string(threads);
        if (key == nextKey && context && vision) return;
        vision.reset(); context.reset(); model.reset(); key.clear();
        const auto start = Clock::now();
        ggml_backend_dev_t devices[] = {nullptr};
        auto mp = llama_model_default_params();
        mp.devices = devices; mp.n_gpu_layers = 0; mp.split_mode = LLAMA_SPLIT_MODE_NONE;
        model.reset(llama_model_load_from_file(modelPath.c_str(), mp));
        if (!model) throw std::runtime_error("model load failed");
        auto cp = llama_context_default_params();
        cp.n_ctx = kContext; cp.n_batch = kBatch; cp.n_ubatch = kBatch; cp.n_seq_max = 1;
        cp.n_threads = threads; cp.n_threads_batch = threads; cp.offload_kqv = false; cp.op_offload = false;
        cp.n_outputs_max = 1; cp.n_outputs_max_per_seq = 1; cp.no_perf = false;
        cp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;
        context.reset(llama_init_from_model(model.get(), cp));
        if (!context) throw std::runtime_error("model context allocation failed");
        auto vp = mtmd_context_params_default();
        vp.use_gpu = false; vp.device = nullptr; vp.n_threads = threads; vp.warmup = false;
        vp.print_timings = false; vp.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;
        vp.image_min_tokens = 64; vp.image_max_tokens = 1024;
        vision.reset(mtmd_init_from_file(projectorPath.c_str(), model.get(), vp));
        if (!vision || !mtmd_support_vision(vision.get())) throw std::runtime_error("vision projector load failed");
        key = nextKey; loadMs = elapsed(start);
    }
    Json run(const Json &request) {
        const bool cold = key.empty();
        load(request);
        const auto started = Clock::now();
        const auto prompt = request.at("prompt").get<std::string>();
        const auto system = request.at("system").get<std::string>();
        const auto grammar = request.value("grammar", std::string());
        const int maxTokens = request.value("maxTokens", 128);
        if (prompt.empty() || prompt.size() > 16000 || system.size() > 16000 || grammar.size() > 16000 || maxTokens < 1 || maxTokens > 1024) throw std::runtime_error("invalid generation parameters");
        const std::string marker = mtmd_get_marker(vision.get());
        for (const auto &reserved : {marker, std::string("<img>"), std::string("<audio>"), std::string("<video>")}) {
            if (prompt.find(reserved) != std::string::npos || system.find(reserved) != std::string::npos) throw std::runtime_error("reserved media marker");
        }
        std::unique_ptr<mtmd_bitmap, decltype(&mtmd_bitmap_free)> bitmap(nullptr, mtmd_bitmap_free);
        if (request.contains("rgbBase64")) {
            const int width = request.at("width").get<int>(), height = request.at("height").get<int>();
            if (width < 1 || height < 1 || width > 1600 || height > 1600 || width * height > 2500000) throw std::runtime_error("invalid image dimensions");
            const auto rgb = decodeBase64(request.at("rgbBase64").get<std::string>());
            if (rgb.size() != static_cast<size_t>(width * height * 3)) throw std::runtime_error("invalid RGB buffer");
            bitmap.reset(mtmd_bitmap_init(width, height, rgb.data()));
            if (!bitmap) throw std::runtime_error("image allocation failed");
        }
        auto *ctx = context.get(); auto *mctx = vision.get(); const auto *vocab = llama_model_get_vocab(model.get());
        llama_synchronize(ctx); llama_memory_clear(llama_get_memory(ctx), true); llama_perf_context_reset(ctx);
        std::unique_ptr<mtmd_input_chunks, decltype(&mtmd_input_chunks_free)> chunks(mtmd_input_chunks_init(), mtmd_input_chunks_free);
        const auto formatted = formatPrompt(system, bitmap ? marker + "\n" + prompt : prompt);
        mtmd_input_text input{formatted.data(), formatted.size(), true, true};
        const mtmd_bitmap *pointer = bitmap.get();
        if (mtmd_tokenize(mctx, chunks.get(), &input, bitmap ? &pointer : nullptr, bitmap ? 1 : 0) != 0) throw std::runtime_error("multimodal tokenization failed");
        const auto promptTokens = mtmd_helper_get_n_tokens(chunks.get());
        if (promptTokens + maxTokens > kContext) throw std::runtime_error("model context limit reached");
        llama_pos past = 0;
        double visionMs = 0, prefillMs = 0;
        const auto chunkCount = mtmd_input_chunks_size(chunks.get());
        if (!chunkCount) throw std::runtime_error("empty prompt");
        for (size_t i = 0; i < chunkCount; i++) {
            const auto *chunk = mtmd_input_chunks_get(chunks.get(), i); auto next = past; int result = 0;
            auto phase = Clock::now();
            if (mtmd_input_chunk_get_type(chunk) == MTMD_INPUT_CHUNK_TYPE_IMAGE) {
                result = mtmd_encode_chunk(mctx, chunk); visionMs += elapsed(phase);
                if (result != 0) throw std::runtime_error("vision encoding failed");
                auto *embedding = mtmd_get_output_embd(mctx);
                requireFinite(embedding, static_cast<size_t>(llama_model_n_embd_inp(model.get())) * mtmd_input_chunk_get_n_tokens(chunk), false);
                phase = Clock::now();
                result = mtmd_helper_decode_image_chunk(mctx, ctx, chunk, embedding, past, 0, kBatch, &next, nullptr, nullptr);
            } else if (mtmd_input_chunk_get_type(chunk) == MTMD_INPUT_CHUNK_TYPE_TEXT) {
                result = mtmd_helper_eval_chunk_single(mctx, ctx, chunk, past, 0, kBatch, i + 1 == chunkCount, &next);
            } else throw std::runtime_error("unsupported media type");
            llama_synchronize(ctx); prefillMs += elapsed(phase);
            if (result != 0) throw std::runtime_error("prompt evaluation failed");
            past = next;
        }
        std::unique_ptr<llama_sampler, decltype(&llama_sampler_free)> sampler(llama_sampler_chain_init(llama_sampler_chain_default_params()), llama_sampler_free);
        if (!grammar.empty()) {
            auto *filter = llama_sampler_init_grammar(vocab, grammar.c_str(), "root");
            if (!filter) throw std::runtime_error("invalid output grammar");
            llama_sampler_chain_add(sampler.get(), filter);
        }
        llama_sampler_chain_add(sampler.get(), llama_sampler_init_greedy());
        std::string output; bool eos = false; int generated = 0; double firstTokenMs = 0;
        struct Batch { llama_batch value = llama_batch_init(1, 0, 1); ~Batch() { llama_batch_free(value); } } batch;
        for (; generated < maxTokens; generated++) {
            requireFinite(llama_get_logits_ith(ctx, -1), llama_vocab_n_tokens(vocab), true);
            const auto token = llama_sampler_sample(sampler.get(), ctx, -1);
            if (llama_vocab_is_eog(vocab, token)) { eos = true; break; }
            if (!generated) firstTokenMs = elapsed(started);
            std::vector<char> piece(128); int size = llama_token_to_piece(vocab, token, piece.data(), piece.size(), 0, true);
            if (size < 0) { piece.resize(-size); size = llama_token_to_piece(vocab, token, piece.data(), piece.size(), 0, true); }
            if (size < 0) throw std::runtime_error("token decoding failed");
            output.append(piece.data(), size);
            if (output.size() > 16000) throw std::runtime_error("model output too large");
            auto &b = batch.value; b.n_tokens = 1; b.token[0] = token; b.pos[0] = past++; b.n_seq_id[0] = 1; b.seq_id[0][0] = 0; b.logits[0] = true;
            if (llama_decode(ctx, b) != 0) throw std::runtime_error("generation failed");
            llama_synchronize(ctx);
        }
        return {{"text", output}, {"status", eos ? "eos" : "max_tokens"}, {"durationMs", elapsed(started)},
            {"loadMs", cold ? loadMs : 0}, {"visionMs", visionMs}, {"prefillMs", prefillMs}, {"firstTokenMs", firstTokenMs},
            {"tokens", generated}, {"promptTokens", promptTokens}, {"backend", "cpu"}, {"engineRevision", MOTE_LLAMA_REVISION}};
    }
};

int main() {
    llama_log_set(quietLog, nullptr); mtmd_helper_log_set(quietLog, nullptr); llama_backend_init();
    Engine engine;
    std::string line;
    while (std::getline(std::cin, line)) {
        std::string id;
        try {
            if (line.size() > 12500000) throw std::runtime_error("request too large");
            const auto request = Json::parse(line); id = request.at("id").get<std::string>();
            if (id.empty() || id.size() > 100) throw std::runtime_error("invalid request id");
            const auto result = engine.run(request.at("payload"));
            std::cout << Json({{"id", id}, {"ok", true}, {"result", result}}).dump(-1, ' ', false, Json::error_handler_t::replace) << std::endl;
        } catch (...) {
            // Never serialize model input, file paths, output fragments, or native diagnostics on failure.
            std::cout << Json({{"id", id}, {"ok", false}}).dump() << std::endl;
            return 1; // Parent owns recovery; stale native state is never reused.
        }
    }
    return 0;
}

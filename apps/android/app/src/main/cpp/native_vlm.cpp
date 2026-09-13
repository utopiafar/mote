// CPU lifecycle and Qwen ChatML/no-thinking convention adapted from the user-provided
// context-collector-lab demo. Image inputs use mtmd's in-memory decoder, never disk.
#include <jni.h>
#include <llama.h>
#include <mtmd.h>
#include <mtmd-helper.h>
#include <nlohmann/json.hpp>
#include <memory>
#include <mutex>
#include <map>
#include <vector>
#include <string>
#include <stdexcept>
#include <cmath>
#include <chrono>
#include <algorithm>
namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
double ms(Clock::time_point start) { return std::chrono::duration<double,std::milli>(Clock::now()-start).count(); }
std::string string(JNIEnv* env, jstring input) {
    if (!input) return {};
    auto klass=env->FindClass("java/lang/String");
    auto method=env->GetMethodID(klass,"getBytes","(Ljava/lang/String;)[B");
    auto encoding=env->NewStringUTF("UTF-8");
    auto bytes=static_cast<jbyteArray>(env->CallObjectMethod(input,method,encoding));
    if (!bytes || env->ExceptionCheck()) throw std::runtime_error("Cannot read input string");
    std::string result(env->GetArrayLength(bytes), '\0');
    env->GetByteArrayRegion(bytes,0,result.size(),reinterpret_cast<jbyte*>(result.data()));
    env->DeleteLocalRef(bytes);env->DeleteLocalRef(encoding);env->DeleteLocalRef(klass);return result;
}
jstring java(JNIEnv* env, const std::string& text) {
    auto bytes=env->NewByteArray(text.size());
    env->SetByteArrayRegion(bytes,0,text.size(),reinterpret_cast<const jbyte*>(text.data()));
    auto klass=env->FindClass("java/lang/String");
    auto constructor=env->GetMethodID(klass,"<init>","([BLjava/lang/String;)V");
    auto encoding=env->NewStringUTF("UTF-8");
    auto result=static_cast<jstring>(env->NewObject(klass,constructor,bytes,encoding));
    env->DeleteLocalRef(bytes); env->DeleteLocalRef(encoding); env->DeleteLocalRef(klass); return result;
}
void error(JNIEnv* env) { auto klass=env->FindClass("java/lang/IllegalStateException"); env->ThrowNew(klass,"Local Qwen engine failed; reload required"); }
struct Engine {
    std::unique_ptr<llama_model,decltype(&llama_model_free)> model{nullptr,llama_model_free};
    std::unique_ptr<llama_context,decltype(&llama_free)> context{nullptr,llama_free};
    std::unique_ptr<mtmd_context,decltype(&mtmd_free)> vision{nullptr,mtmd_free};
    std::mutex mutex; bool usable=true; double loadMs=0;
};
std::mutex registryMutex;
std::map<jlong,std::shared_ptr<Engine>> engines;
jlong next=1;
std::once_flag initialized;
std::shared_ptr<Engine> get(jlong handle) { std::lock_guard<std::mutex> guard(registryMutex); return engines.at(handle); }
void quiet(enum ggml_log_level,const char*,void*) {} // Never log prompt, screen contents or generated text.
std::string format(const std::string& system,const std::string& prompt) {
    std::vector<llama_chat_message> messages{{"system",system.c_str()},{"user",prompt.c_str()}};
    std::vector<char> output(system.size()*2+prompt.size()*2+1024);
    int count=llama_chat_apply_template("chatml",messages.data(),messages.size(),true,output.data(),output.size());
    if(count<0) throw std::runtime_error("Invalid template");
    if(static_cast<size_t>(count)>=output.size()) { output.resize(count+1); count=llama_chat_apply_template("chatml",messages.data(),messages.size(),true,output.data(),output.size()); }
    if(count<0) throw std::runtime_error("Invalid template");
    return std::string(output.data(),count)+"<think>\n\n</think>\n\n";
}
}
extern "C" JNIEXPORT jlong JNICALL Java_dev_mote_collector_NativeVlm_load(JNIEnv* env,jclass,jstring language,jstring vision,jint threads) {
    try {
        if(threads<1||threads>8)throw std::runtime_error("Invalid threads");
        std::call_once(initialized,[]{llama_log_set(quiet,nullptr);mtmd_helper_log_set(quiet,nullptr);llama_backend_init();});
        auto start=Clock::now(); auto engine=std::make_shared<Engine>();
        auto model=llama_model_default_params(); model.n_gpu_layers=0; model.split_mode=LLAMA_SPLIT_MODE_NONE;
        ggml_backend_dev_t devices[]={nullptr}; model.devices=devices;
        engine->model.reset(llama_model_load_from_file(string(env,language).c_str(),model));
        if(!engine->model)throw std::runtime_error("Model unavailable");
        auto context=llama_context_default_params(); context.n_ctx=4096;context.n_batch=512;context.n_ubatch=512;context.n_seq_max=1;
        context.n_threads=threads;context.n_threads_batch=threads;context.offload_kqv=false;context.op_offload=false;
        context.flash_attn_type=LLAMA_FLASH_ATTN_TYPE_DISABLED;context.no_perf=false;
        engine->context.reset(llama_init_from_model(engine->model.get(),context));
        if(!engine->context)throw std::runtime_error("Context unavailable");
        auto projector=mtmd_context_params_default();projector.use_gpu=false;projector.n_threads=threads;projector.warmup=false;
        projector.print_timings=false;projector.flash_attn_type=LLAMA_FLASH_ATTN_TYPE_DISABLED;projector.image_min_tokens=64;projector.image_max_tokens=1536;
        engine->vision.reset(mtmd_init_from_file(string(env,vision).c_str(),engine->model.get(),projector));
        if(!engine->vision||!mtmd_support_vision(engine->vision.get()))throw std::runtime_error("Projector unavailable");
        engine->loadMs=ms(start);
        std::lock_guard<std::mutex> guard(registryMutex);auto id=next++;engines.emplace(id,engine);return id;
    }catch(...){error(env);return 0;}
}
extern "C" JNIEXPORT jstring JNICALL Java_dev_mote_collector_NativeVlm_run(JNIEnv* env,jclass,jlong handle,jbyteArray image,jstring system,jstring prompt,jint maxTokens,jstring grammar) {
    std::shared_ptr<Engine> engine;
    try {
        engine=get(handle);std::lock_guard<std::mutex> guard(engine->mutex);
        if(!engine->usable||maxTokens<32||maxTokens>1024)throw std::runtime_error("Invalid session");
        auto start=Clock::now();auto ctx=engine->context.get();auto mctx=engine->vision.get();auto vocab=llama_model_get_vocab(engine->model.get());
        llama_synchronize(ctx);llama_memory_clear(llama_get_memory(ctx),true);
        std::unique_ptr<mtmd_bitmap,decltype(&mtmd_bitmap_free)> bitmap(nullptr,mtmd_bitmap_free);
        auto imageSize=image?env->GetArrayLength(image):0;
        if(imageSize>12*1024*1024)throw std::runtime_error("Image too large");
        if(imageSize>0){
            std::vector<unsigned char> bytes(imageSize);env->GetByteArrayRegion(image,0,imageSize,reinterpret_cast<jbyte*>(bytes.data()));
            auto decoded=mtmd_helper_bitmap_init_from_buf(mctx,bytes.data(),bytes.size(),false,mtmd_helper_init_opt_default());
            bitmap.reset(decoded.bitmap);if(decoded.video_ctx)mtmd_helper_video_free(decoded.video_ctx);
            if(!bitmap||mtmd_bitmap_is_audio(bitmap.get()))throw std::runtime_error("Invalid image");
        }
        auto text=string(env,prompt);auto systemText=string(env,system);
        const std::string marker=mtmd_get_marker(mctx);
        if(text.empty()||text.find(marker)!=std::string::npos||systemText.find(marker)!=std::string::npos)throw std::runtime_error("Reserved image marker");
        auto formatted=format(systemText,bitmap?marker+"\n"+text:text);
        mtmd_input_text input{formatted.data(),formatted.size(),true,true};
        std::unique_ptr<mtmd_input_chunks,decltype(&mtmd_input_chunks_free)> chunks(mtmd_input_chunks_init(),mtmd_input_chunks_free);
        const mtmd_bitmap* pointer=bitmap.get();
        if(mtmd_tokenize(mctx,chunks.get(),&input,bitmap?&pointer:nullptr,bitmap?1:0)!=0)throw std::runtime_error("Tokenize failed");
        auto tokens=mtmd_helper_get_n_tokens(chunks.get());if(tokens+maxTokens>4096)throw std::runtime_error("Context overflow");
        auto prepareMs=ms(start);auto phase=Clock::now();llama_pos past=0;
        if(mtmd_helper_eval_chunks(mctx,ctx,chunks.get(),0,0,512,true,&past)!=0)throw std::runtime_error("Vision/prefill failed");
        llama_synchronize(ctx);auto prefillMs=ms(phase);
        std::unique_ptr<llama_sampler,decltype(&llama_sampler_free)> sampler(llama_sampler_chain_init(llama_sampler_chain_default_params()),llama_sampler_free);
        auto rules=string(env,grammar);
        if(!rules.empty()){auto constraints=llama_sampler_init_grammar(vocab,rules.c_str(),"root");if(!constraints)throw std::runtime_error("Invalid grammar");llama_sampler_chain_add(sampler.get(),constraints);}
        llama_sampler_chain_add(sampler.get(),llama_sampler_init_greedy());
        std::string output;int generated=0;bool complete=false;phase=Clock::now();
        while(generated<maxTokens){
            auto logits=llama_get_logits_ith(ctx,-1);if(!logits)throw std::runtime_error("Missing logits");
            for(int i=0;i<llama_vocab_n_tokens(vocab);++i)if(!std::isfinite(logits[i]))throw std::runtime_error("Nonfinite logits");
            const auto token=llama_sampler_sample(sampler.get(),ctx,-1);
            if(llama_vocab_is_eog(vocab,token)){complete=true;break;}
            std::vector<char> piece(256);int count=llama_token_to_piece(vocab,token,piece.data(),piece.size(),0,true);
            if(count<0){piece.resize(-count);count=llama_token_to_piece(vocab,token,piece.data(),piece.size(),0,true);}
            if(count<0)throw std::runtime_error("Token decode failed");output.append(piece.data(),count);++generated;
            if(generated>=maxTokens)break;
            llama_batch batch=llama_batch_init(1,0,1);batch.n_tokens=1;batch.token[0]=token;batch.pos[0]=past++;
            batch.n_seq_id[0]=1;batch.seq_id[0][0]=0;batch.logits[0]=true;
            auto result=llama_decode(ctx,batch);llama_batch_free(batch);llama_synchronize(ctx);
            if(result!=0)throw std::runtime_error("Generation failed");
        }
        return java(env,Json{{"status",complete?"eos":"max_tokens"},{"text",output},{"loadMs",engine->loadMs},{"prepareMs",prepareMs},
            {"visionPrefillMs",prefillMs},{"decodeMs",ms(phase)},{"wallMs",ms(start)},{"tokens",generated},{"promptTokens",tokens},{"backend","cpu"}}.dump());
    }catch(...){if(engine)engine->usable=false;error(env);return nullptr;}
}
extern "C" JNIEXPORT void JNICALL Java_dev_mote_collector_NativeVlm_release(JNIEnv*,jclass,jlong handle){std::lock_guard<std::mutex> guard(registryMutex);engines.erase(handle);}

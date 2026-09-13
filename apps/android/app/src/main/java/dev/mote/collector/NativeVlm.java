package dev.mote.collector;

/** Generic offline Qwen image/text runner. Images are encoded bytes held in RAM, never file paths. */
public final class NativeVlm {
    static { System.loadLibrary("mote_vlm"); }
    private NativeVlm() {}
    public static native long load(String languagePath, String visionPath, int threads);
    public static native String run(long handle, byte[] image, String system, String prompt, int maxTokens, String grammar);
    public static native void release(long handle);
}

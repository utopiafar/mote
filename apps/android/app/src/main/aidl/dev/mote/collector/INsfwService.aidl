package dev.mote.collector;
import android.os.SharedMemory;
interface INsfwService {
    int processId();
    String review(in SharedMemory image, int threads, int maxTokens, String policy);
}

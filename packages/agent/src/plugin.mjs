import {CONTEXT_TOOLS} from "./context-tools.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { apply as applySkillTool } from "@deepseek-ai/dsh-tool-skill";

export const name = "mote-context";
export const inject = ["tools", "skills", "agents"];
const names = ["progress_update", "search_context", "timeline", "evidence", "activity", "media_activity", "devices", "sources", "source_items", "source_history", "memories", "file_chunks", "changes"];
/** Bound decoded provider bytes before the SDK buffers SSE or error bodies.
 * A token parameter and wall-clock timeout do not constrain a hostile response.
 * The limit covers retries and repair turns in this isolated agent process. */
export function boundedModelFetch(transport, bridge, maximumBytes = 32 * 1024 * 1024, configuration) {
  let received = 0;
  let exceeded = false;
  const tooLarge = () => new Error("Model response exceeds the agent byte budget");
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    // Bridge responses already have their own authenticated evidence byte budget.
    if (url.startsWith(bridge + "/")) return transport(input, init);
    if (exceeded) throw tooLarge();
    // Redirects can forward personal evidence to a destination the owner never
    // selected. SSE is the only enabled SDK transport, so this covers every turn.
    let requestInit = {...init, redirect: 'manual'};
    if (configuration) {
      const destination = new URL(url), base = new URL(configuration.baseUrl);
      const prefix = base.pathname.replace(/\/+$/, '');
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (destination.origin !== base.origin || (destination.pathname !== prefix && !destination.pathname.startsWith(prefix + '/')) || method.toUpperCase() !== 'POST') throw new Error('Unexpected model transport destination');
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      for (const [key, value] of new Headers(init?.headers)) headers.set(key, value);
      if (configuration.provider === 'azure-openai') {
        headers.delete('authorization');
        headers.set('api-key', process.env.MOTE_MODEL_API_KEY);
      }
      for (const [key, value] of Object.entries(configuration.headers ?? {})) headers.set(key, value);
      const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      if (typeof raw !== 'string') throw new Error('Model request must contain a JSON body');
      const body = JSON.parse(raw);
      if (configuration.protocol === 'deepseek' && configuration.reasoningEffort === 'auto') {
        // The legacy adapter cannot omit its own defaults. Remove only those
        // defaults before applying the owner's explicitly supplied parameters.
        delete body.thinking;
        delete body.reasoning_effort;
      }
      // MiniMax's default inline <think> output would mix reasoning into the
      // final JSON. This changes wire format only, not whether the model thinks.
      if (configuration.provider === 'minimax' && configuration.protocol === 'openai-completions') body.reasoning_split = true;
      const merge = (base, extra) => {
        const result = {...base};
        for (const [key, value] of Object.entries(extra)) result[key] = value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key]) ? merge(result[key], value) : value;
        return result;
      };
      const customized = merge(body, configuration.extraBody ?? {});
      if (configuration.protocol === 'openai-responses') customized.store = false;
      headers.delete('content-length');
      requestInit = {...requestInit, headers, body: JSON.stringify(customized)};
    }
    const response = await transport(input, requestInit);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      // A deterministic refusal avoids the SDK treating a redirect as a
      // transient network exception and repeatedly resending the same evidence.
      return new Response(JSON.stringify({error:{message:'Model redirects are not allowed'}}), {status:400, headers:{'Content-Type':'application/json'}});
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { reader.releaseLock(); controller.close(); return; }
          received += value.byteLength;
          if (received > maximumBytes) {
            exceeded = true;
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
            controller.error(tooLarge());
            return;
          }
          controller.enqueue(value);
        } catch (error) { controller.error(error); }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export async function apply(ctx) {
  for (const skill of JSON.parse(process.env.MOTE_SKILLS || '[]')) {
    ctx.skills.register({name:skill.name,description:skill.description,content:skill.content,source:'bundled',metadata:{version:skill.version}});
  }
  applySkillTool(ctx);
  const endpoint = process.env.MOTE_CONTEXT_BRIDGE;
  const token = process.env.MOTE_CONTEXT_BRIDGE_TOKEN;
  if (!endpoint || !token) throw new Error("Mote context bridge is missing");
  const configuration = process.env.MOTE_MODEL_TRANSPORT ? JSON.parse(process.env.MOTE_MODEL_TRANSPORT) : undefined;
  globalThis.fetch = boundedModelFetch(globalThis.fetch, endpoint, undefined, configuration);
  async function call(tool, args, signal) {
    const response = await fetch(`${endpoint}/${tool}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(args),
      signal,
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || "Mote context tool failed");
    return result;
  }
  for (const [tool, description, parameters] of CONTEXT_TOOLS) {
    ctx.tools.register(
      defineTool({
        name: tool,
        description,
        parameters,
        output: {
          schema: { type: "json" },
          render: (_args, value) => [
            { type: "text", text: JSON.stringify(value) },
          ],
        },
        async execute(args, exec) {
          return call(tool, args, exec.signal);
        },
      }),
    );
  }
  // Monotonic deny: an accidental dependency must not grant the agent another capability.
  ctx.tools.guard((exec) =>
    (names.includes(exec.name) || exec.name === 'skill')
      ? undefined
      : "Mote exposes only read-only context tools",
  );
  const exposed = ctx.tools.schemas().map((tool) => tool.name);
  await call("_ready", { tools: exposed });
  ctx.provide("moteReady", { tools: [...names,'skill'] });
}

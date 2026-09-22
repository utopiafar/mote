import {CONTEXT_TOOLS} from "./context-tools.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { apply as applySkillTool } from "@deepseek-ai/dsh-tool-skill";

export const name = "mote-context";
export const inject = ["tools", "skills", "agents", "attachments"];
const names = ["read_image","progress_update", "search_context", "timeline", "evidence", "activity", "media_activity", "devices", "sources", "source_items", "source_history", "memories", "read_file_evidence", "file_chunks", "changes"];
/** Bound decoded provider bytes before the SDK buffers SSE or error bodies.
 * A token parameter and wall-clock timeout do not constrain a hostile response.
 * The limit covers retries and repair turns in this isolated agent process. */
export function boundedModelFetch(transport, bridge, maximumBytes = 32 * 1024 * 1024, configuration, reportFailure) {
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
    let response;
    try {response = await transport(input, requestInit);} catch (error) {if (reportFailure && !requestInit.signal?.aborted) await reportFailure({status:0});throw error;}
    if (reportFailure && !response.ok) {
      await response.body?.cancel();
      const retryAfter=response.headers.get('retry-after');
      await reportFailure({status:response.status,...(retryAfter&&retryAfter.length<=128?{retryAfter}:{})});
      // Suppress opaque SDK retries. The durable host received the real status.
      return new Response(JSON.stringify({error:{message:'Model request stopped by host'}}),{status:400,headers:{'Content-Type':'application/json'}});
    }
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

export function modelFailureReporter(transport) {
  const configured=process.env.MOTE_MODEL_OBSERVER;if(!configured)return undefined;
  const {url,token}=JSON.parse(configured);
  return async value=>{const response=await transport(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(value),redirect:'error',signal:AbortSignal.timeout(5000)});await response.body?.cancel();if(!response.ok)throw Error('Host transport observer unavailable');};
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
  const transport=globalThis.fetch.bind(globalThis);
  globalThis.fetch = boundedModelFetch(transport, endpoint, undefined, configuration, modelFailureReporter(transport));
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
      throw new Error(result.toolError ? JSON.stringify({toolError:result.toolError}) : "Mote context tool failed");
    return result;
  }
  const allowed = JSON.parse(process.env.MOTE_TASK_TOOLS || JSON.stringify(names));
  for (const [tool, description, parameters] of CONTEXT_TOOLS) {
    if (!allowed.includes(tool)) continue;
    ctx.tools.register(
      defineTool({
        name: tool,
        description,
        parameters,
        output: {
          schema: { type: "json" },
          render: (_args, value) => value?.imageAttachment ? [{type:'text',text:JSON.stringify({id:value.id,source:'untrusted_personal_context'})},{type:'image',attachment:value.imageAttachment}] : [{type:'text',text:JSON.stringify(value)}],
        },
        async execute(args, exec) {
          const value=await call(tool,args,exec.signal);
          if(tool==='read_image'){
            const attachments=ctx.get('attachments');if(!attachments)throw Error('This model runtime does not support image attachments');
            const imageAttachment=await attachments.saveImage({data:Buffer.from(value.image.data,'base64'),mediaType:value.image.mimeType,name:'capture'});
            return {id:value.id,imageAttachment};
          }
          return value;
        },
      }),
    );
  }
  // Monotonic deny: an accidental dependency must not grant the agent another capability.
  ctx.tools.guard((exec) =>
    (allowed.includes(exec.name) || exec.name === 'skill')
      ? undefined
      : "Mote exposes only read-only context tools",
  );
  const exposed = ctx.tools.schemas().map((tool) => tool.name);
  await call("_ready", { tools: exposed });
  ctx.provide("moteReady", { tools: [...allowed,'skill'] });
}

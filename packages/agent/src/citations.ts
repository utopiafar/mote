import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { AgentResponseError } from './types.js';

interface MarkdownNode { type:string; value?:string; children?:MarkdownNode[] }
const parser = unified().use(remarkParse);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opaqueNodes = new Set(['code', 'inlineCode', 'link', 'linkReference', 'definition', 'html', 'image', 'imageReference']);

/** Validate citation syntax only. Captured prose never chooses rules or executes actions. */
export function validateInlineCitations(answer:string, declaredIds:Iterable<string>, retrievedIds:Iterable<string>):void {
  const declared = new Set(declaredIds), retrieved = new Set(retrievedIds);
  const knownUuids = [...new Set([...declared, ...retrieved])].filter(id => uuid.test(id)).map(id => id.toLowerCase());
  function visit(node:MarkdownNode):void {
    if (opaqueNodes.has(node.type)) return;
    if (node.type === 'text' && node.value) {
      for (const match of node.value.matchAll(/\[([^\[\]\n]{1,300})\]/g)) {
        const id = match[1];
        // UUIDs are the production protocol's identifiers. Known non-UUID IDs
        // also support custom readers and synthetic tests; ordinary [labels] are text.
        if (!uuid.test(id) && !retrieved.has(id)) {
          // Eight characters is the UUID's first complete group. Reject a known
          // strict prefix even when ambiguous; never guess or expand an evidence ID.
          // Exact custom reader IDs above remain valid, and ordinary labels stay text.
          if (id.length >= 8 && id.length < 36 && knownUuids.some(known => known.startsWith(id.toLowerCase()))) {
            throw new AgentResponseError('The model used a truncated inline citation. Use the complete retrieved evidence ID.', 'truncated_citation');
          }
          continue;
        }
        if (!retrieved.has(id)) throw new AgentResponseError('The model used an inline citation that was not retrieved in this run.', 'unretrieved_citation');
        if (!declared.has(id)) throw new AgentResponseError('The model used an inline citation missing from citationIds.', 'undeclared_citation');
      }
    }
    node.children?.forEach(visit);
  }
  visit(parser.parse(answer));
}

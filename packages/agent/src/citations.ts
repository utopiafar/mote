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
  function visit(node:MarkdownNode):void {
    if (opaqueNodes.has(node.type)) return;
    if (node.type === 'text' && node.value) {
      for (const match of node.value.matchAll(/\[([^\[\]\n]{1,300})\]/g)) {
        const id = match[1];
        // UUIDs are the production protocol's identifiers. Known non-UUID IDs
        // also support custom readers and synthetic tests; ordinary [labels] are text.
        if (!uuid.test(id) && !retrieved.has(id)) continue;
        if (!retrieved.has(id)) throw new AgentResponseError('The model used an inline citation that was not retrieved in this run.');
        if (!declared.has(id)) throw new AgentResponseError('The model used an inline citation missing from citationIds.');
      }
    }
    node.children?.forEach(visit);
  }
  visit(parser.parse(answer));
}

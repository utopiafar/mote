// Standalone consumers (tests, benchmarks, entrypoint import checks) receive
// the same registered official descriptors as the application entrypoint.
import '../../tools/official-read-packs.js';
import type {QueryInput} from '../../query-contracts.js';
import {bundledSkills} from '../../skills.js';
import {contextToolDefinitions, contextToolSnapshot} from '../../tool-contributions.js';
import {toolInputSchema, toCodexTool} from '../../tools/runtime-schema.js';
import type {CodexTool} from '../../codex-session.js';

/** Codex wire projection of the same pinned Host snapshot. The App Server has no
 * tool-version field, so the provider matches names, descriptions and input
 * schemas while the Host keeps the pin beside the frame. */
function codexToolsFor(input: QueryInput, snapshot = contextToolSnapshot(input)): CodexTool[] {
  const pins = new Map(snapshot.entries.map(entry => [entry.name, entry]));
  return [...contextToolDefinitions(input).map(([name, description, fields]): CodexTool => {
    const pin = pins.get(name);
    return pin ? toCodexTool(pin) : {type: 'function', name, description, inputSchema: toolInputSchema(fields)};
  }), {type: 'function', name: 'skill', description: 'Read a bundled Mote procedure by name. Available: ' + bundledSkills.filter(skill => skill.availability !== 'import').map(skill => skill.id).join(', '), inputSchema: {type: 'object', properties: {name: {type: 'string'}}, required: ['name'], additionalProperties: false}}];
}

export const codexContextTools = codexToolsFor({question: ''});

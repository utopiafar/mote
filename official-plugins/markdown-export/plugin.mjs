/** Official Markdown / Obsidian continuous export package.
 *
 * This module is declarative on purpose. It names a safe folder, the Markdown
 * extension and the frontmatter choice; the Central host owns the export
 * cursor, the target sandbox, sensitive-source filtering and every decision
 * about overwriting a file the owner has edited. The package never writes
 * files, persists cursor state or decides whether a target is safe. */
export const sdkVersion = '0.1.0';

export const outboundExport = Object.freeze({
  apiVersion: 1,
  id: 'mote.official.markdown-export',
  format: Object.freeze({extension: 'md', frontmatter: 'yaml', folder: 'Mote'}),
});

export default outboundExport;

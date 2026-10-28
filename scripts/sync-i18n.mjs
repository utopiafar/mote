import {readFile, writeFile} from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const locales = ['en', 'ja', 'fr', 'de', 'es', 'ru'];
for (const locale of locales) {
  const source = await readFile(new URL(`packages/shared/src/i18n-${locale}.ts`, root), 'utf8');
  const catalog = JSON.parse(source.slice(source.indexOf('= ') + 2).trim().replace(/;$/, ''));
  const output = JSON.stringify(catalog, null, 2) + '\n';
  const target = new URL(`apps/android/app/src/main/assets/i18n-${locale}.json`, root);
  if (process.argv.includes('--check')) {
    if (await readFile(target, 'utf8') !== output) throw Error(`Run node scripts/sync-i18n.mjs to update the Android ${locale} catalog`);
  } else await writeFile(target, output);
}

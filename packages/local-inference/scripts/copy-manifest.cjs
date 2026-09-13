const { copyFileSync, rmSync } = require('node:fs');
const { resolve } = require('node:path');
copyFileSync(resolve(__dirname, '../../../models/qwen-manifest.json'), resolve(__dirname, '../dist/qwen-manifest.json'));
copyFileSync(resolve(__dirname, '../../../models/review-policy.txt'), resolve(__dirname, '../dist/review-policy.txt'));
for (const file of ['review-system.txt', 'review-grammar.gbnf']) copyFileSync(resolve(__dirname, '../../../models', file), resolve(__dirname, '../dist', file));
rmSync(resolve(__dirname, '../dist/nsfw-manifest.json'), { force: true });

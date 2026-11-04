#!/usr/bin/env node
/** Scan support bundles and compiled bundles for sensitive material.
 *
 * Support bundles have a structural contract: captured text, titles, paths,
 * URLs, credentials and device identifiers must never be exported. Compiled
 * bundles are scanned for credential formats and host-private absolute paths.
 * Generated private-body markers can be supplied explicitly because arbitrary
 * prose is indistinguishable from product copy in a compiled artifact.
 *
 * Findings never include the full matched value; callers can print the report
 * without leaking the secret they are trying to remove. */
import {lstat, readFile, readdir} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {basename, extname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repository = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const defaultPrivateRoots = [...new Set([homedir(), tmpdir(), repository].map(path => resolve(path)).filter(path => path.length > 4))];
const maxFileBytes = 32 * 1024 * 1024;
const binaryExtensions = new Set([
  '.7z', '.apk', '.avif', '.bin', '.bmp', '.br', '.class', '.dmg', '.gif', '.gz', '.ico', '.jar', '.jpeg', '.jpg',
  '.mov', '.mp3', '.mp4', '.node', '.ogg', '.otf', '.pdf', '.png', '.tar', '.tgz', '.ttf', '.wav', '.webm',
  '.webp', '.woff', '.woff2', '.wasm', '.zip',
]);
const forbiddenSupportKeys = new Set([
  'accessToken', 'access_token', 'answer', 'answers', 'apiKey', 'api_key', 'apikey', 'appName', 'authToken',
  'auth_token', 'authorization', 'body', 'capturedText', 'clientSecret', 'client_secret', 'content', 'contents',
  'cookie', 'cookies', 'credential', 'credentials', 'data', 'description', 'deviceId', 'deviceName', 'dir',
  'directory', 'endpoint', 'error', 'errors', 'extraBody', 'file', 'filename', 'files', 'headers', 'message',
  'messages', 'mood', 'note', 'notes', 'ocr', 'ocrText', 'password', 'path', 'paths', 'payload', 'privateKey',
  'private_key', 'prompt', 'prompts', 'raw', 'reason', 'reasoning', 'refreshToken', 'refresh_token', 'secret',
  'secretKey', 'secret_key', 'session', 'stack', 'summary', 'text', 'title', 'titles', 'token', 'trace',
  'transcript', 'uri', 'url', 'windowTitle', 'workspace',
]);
/** The Android support export keeps bounded, sanitized runtime log lines under logs.text. */
const allowedSupportTextPaths = new Set(['logs.text']);

const secretRules = [
  {rule: 'private-key-block', pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g},
  {rule: 'openai-key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}\b/g},
  {rule: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g},
  {rule: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g},
  {rule: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g},
  {rule: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g},
  {rule: 'bearer-token', pattern: /\bBearer\s+(?:eyJ[A-Za-z0-9._-]{20,}|[A-Za-z0-9_-]{20,})/g},
  {
    rule: 'assigned-credential',
    pattern: /\b(?:api[_-]?key|apikey|client[_-]?secret|clientsecret|access[_-]?token|accesstoken|refresh[_-]?token|refreshtoken|auth[_-]?token|authtoken|password|passwd|secret)\b\s*[:=]\s*["'`]([A-Za-z0-9+/=_.~-]{12,})["'`]/gi,
    capture: 1,
    filter: value => /\d/.test(value) && /[A-Za-z]/.test(value),
  },
];
const pathRules = [
  {rule: 'mac-user-path', pattern: /(?:^|[\s"'`=(:,])(?:file:\/\/)?\/Users\/[A-Za-z0-9._-]+\b/g},
  {rule: 'linux-user-path', pattern: /(?:^|[\s"'`=(:,])(?:file:\/\/)?\/home\/[A-Za-z0-9._-]+\b/g},
  {rule: 'mac-private-var-path', pattern: /(?:^|[\s"'`=(:,])(?:file:\/\/)?\/private\/var\/folders\/[A-Za-z0-9._-]+\//g},
  {rule: 'mac-var-path', pattern: /(?:^|[\s"'`=(:,])(?:file:\/\/)?\/var\/folders\/[A-Za-z0-9._-]+\//g},
  {rule: 'windows-user-path', pattern: /(?:^|[\s"'`=(:,])(?:file:\/\/)?(?:[A-Za-z]:\\)?Users\\[^\\\s"'`]+\\(?:[^\s"'`\\]+\\)?/g},
];

function location(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return {line: text.slice(0, lineStart).split('\n').length, column: index - lineStart + 1};
}
function redact(value) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return '[redacted]';
  return `${text.slice(0, 4)}…[${text.length} chars]`;
}
function addFinding(findings, seen, finding) {
  const key = `${finding.type}:${finding.source}:${finding.line}:${finding.column}${finding.type === 'private-body' ? ':' + finding.rule : ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  findings.push(finding);
}
function regexFindings(text, source, findings, seen, rule, type = 'secret') {
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
  for (const match of text.matchAll(pattern)) {
    const value = rule.capture ? match[rule.capture] : match[0];
    if (rule.filter && !rule.filter(value)) continue;
    const start = match.index + (rule.capture ? match[0].indexOf(value) : 0);
    const {line, column} = location(text, start);
    addFinding(findings, seen, {type, rule: rule.rule, source, line, column, excerpt: redact(value)});
  }
}
function privateValueFindings(text, source, privateValues, findings, seen) {
  for (const value of privateValues) {
    if (typeof value !== 'string' || value.length < 4) continue;
    let start = 0, index;
    while ((index = text.indexOf(value, start)) !== -1) {
      const {line, column} = location(text, index);
      addFinding(findings, seen, {type: 'private-body', rule: 'known-private-value', source, line, column, excerpt: redact(value)});
      start = index + value.length;
    }
  }
}
function privateRootFindings(text, source, privateRoots, findings, seen) {
  for (const root of privateRoots) {
    if (typeof root !== 'string' || root.length < 4) continue;
    const normalized = resolve(root);
    let start = 0, index;
    while ((index = text.indexOf(normalized, start)) !== -1) {
      const {line, column} = location(text, index);
      addFinding(findings, seen, {type: 'private-path', rule: 'host-private-root', source, line, column, excerpt: redact(normalized)});
      start = index + normalized.length;
    }
  }
}
function supportFieldFindings(value, source, findings, seen) {
  const walk = (item, path) => {
    if (Array.isArray(item)) {
      item.forEach((child, index) => walk(child, `${path}.${index}`));
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      const childPath = path ? `${path}.${key}` : key;
      const suspicious = forbiddenSupportKeys.has(key) || /private|captured|personal|secret|credential|password/i.test(key);
      if (suspicious && !allowedSupportTextPaths.has(childPath)) {
        addFinding(findings, seen, {
          type: 'private-body', rule: `forbidden-support-field:${key}`, source, line: 1, column: 1,
          excerpt: `${childPath}: [redacted]`,
        });
      }
      walk(child, childPath);
    }
  };
  walk(value, '');
}
export function scanText(text, {
  source = '<text>', privateValues = [], privateRoots = defaultPrivateRoots, supportBundle,
} = {}) {
  const findings = [], seen = new Set();
  privateRootFindings(text, source, privateRoots, findings, seen);
  for (const rule of secretRules) regexFindings(text, source, findings, seen, rule);
  for (const rule of pathRules) regexFindings(text, source, findings, seen, rule, 'private-path');
  privateValueFindings(text, source, privateValues, findings, seen);
  if (supportBundle !== undefined) supportFieldFindings(supportBundle, source, findings, seen);
  return findings;
}
export function isSupportBundle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.scope === 'string' && /(?:^|[-_])support(?:$|[-_])/.test(value.scope)) return true;
  if (value.app && value.state && value.configuration && value.logs && value.samples) return true;
  return false;
}
export function scanSupportBundle(text, options = {}) {
  let value;
  try { value = typeof text === 'string' ? JSON.parse(text) : text; }
  catch (error) { throw Error(`Invalid support bundle JSON: ${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Support bundle must be a JSON object');
  return scanText(typeof text === 'string' ? text : JSON.stringify(value), {...options, supportBundle: value});
}
async function regularFiles(path) {
  const value = await lstat(path);
  if (value.isSymbolicLink()) return {files: [], skipped: [{path, reason: 'symbolic link'}]};
  if (value.isDirectory()) {
    const files = [], skipped = [];
    for (const name of (await readdir(path)).sort()) {
      const child = await regularFiles(join(path, name));
      files.push(...child.files);
      skipped.push(...child.skipped);
    }
    return {files, skipped};
  }
  if (!value.isFile()) return {files: [], skipped: [{path, reason: 'not a regular file'}]};
  return {files: [path], skipped: []};
}
export async function scanArtifacts(paths, options = {}) {
  const privateValues = options.privateValues ?? [];
  const privateRoots = [...defaultPrivateRoots, ...(options.privateRoots ?? [])];
  const kind = options.kind ?? 'auto';
  const discovered = [], skipped = [], findings = [];
  for (const path of paths) {
    const resolved = resolve(path), walk = await regularFiles(resolved);
    discovered.push(...walk.files);
    skipped.push(...walk.skipped);
  }
  let files = 0;
  for (const file of discovered.sort()) {
    const stats = await lstat(file);
    if (stats.size > (options.maxBytes ?? maxFileBytes)) throw Error(`Artifact exceeds the scan size limit: ${file}`);
    if (binaryExtensions.has(extname(file).toLowerCase())) { skipped.push({path: file, reason: 'binary extension'}); continue; }
    const bytes = await readFile(file);
    if (bytes.includes(0)) { skipped.push({path: file, reason: 'binary content'}); continue; }
    files++;
    const text = bytes.toString('utf8'), source = relative(process.cwd(), file) || basename(file);
    if (kind === 'support') {
      findings.push(...scanSupportBundle(text, {source, privateValues, privateRoots}));
      continue;
    }
    if (kind === 'auto') {
      try {
        const parsed = JSON.parse(text);
        if (isSupportBundle(parsed)) {
          findings.push(...scanSupportBundle(text, {source, privateValues, privateRoots}));
          continue;
        }
      } catch {}
    }
    findings.push(...scanText(text, {source, privateValues, privateRoots}));
  }
  return {files, skipped, findings};
}

const usage = `Scan support bundles and compiled bundles for sensitive material
Usage: node scripts/ci/sensitive-scan.mjs [options] <file-or-directory>...
  --support              parse every JSON artifact as a support bundle
  --bundle               scan compiled artifacts without support-bundle field rules
  --private VALUE        generated private-body marker to detect (repeatable)
  --private-root PATH    additional host-private absolute path root (repeatable)
  --max-bytes N          per-artifact size limit (default ${maxFileBytes})
  --json                 print the complete machine-readable report
  --help                 show this help
`;
export async function main(argv = process.argv.slice(2)) {
  const paths = [], privateValues = [], privateRoots = [], modes = new Set();
  let json = false, maxBytes = maxFileBytes;
  const optionValue = index => {
    const next = argv[index + 1];
    if (next === undefined) throw Error(`Missing value for ${argv[index]}`);
    return next;
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--support') modes.add('support');
    else if (value === '--bundle') modes.add('bundle');
    else if (value === '--private') { privateValues.push(optionValue(index)); index++; }
    else if (value === '--private-root') { privateRoots.push(optionValue(index)); index++; }
    else if (value === '--max-bytes') { maxBytes = Number(optionValue(index)); index++; }
    else if (value === '--json') json = true;
    else if (value === '--help' || value === '-h') { console.info(usage); return; }
    else if (value.startsWith('--')) throw Error(`Unknown option: ${value}`);
    else paths.push(value);
  }
  if (modes.size > 1) throw Error('--support and --bundle are mutually exclusive');
  const kind = [...modes][0] ?? 'auto';
  if (!paths.length) throw Error(`At least one artifact path is required\n${usage}`);
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw Error('--max-bytes must be a positive integer');
  const report = await scanArtifacts(paths, {kind, privateValues, privateRoots, maxBytes});
  report.ok = report.findings.length === 0;
  if (json) console.info(JSON.stringify(report, null, 2));
  else if (report.ok) console.info(`Sensitive scan passed: ${report.files} file(s), ${report.skipped.length} skipped.`);
  else {
    for (const finding of report.findings) console.error(`${finding.source}:${finding.line}:${finding.column} ${finding.type} ${finding.rule} (${finding.excerpt})`);
    console.error(`Sensitive scan found ${report.findings.length} issue(s) in ${report.files} file(s).`);
  }
  if (!report.ok) process.exitCode = 1;
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Mote sensitive scan: ${error.message}`); process.exitCode = 1; });
}

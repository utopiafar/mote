import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import ts from 'typescript';
import {
  serviceBindingSchema, serviceRefSchema, type ContributionIdentity, type ServiceBinding, type ServiceLease,
} from '@mote/plugin-api/contracts';
import {
  centralServices, centralServiceOwners, centralMigrationSlices, centralFeatureMigrations, checkCentralServiceDeclarations,
  type CaptureIntake, type MaterialPublication, type VaultTransactions, type CommitAuthority, type CommitAuthorization,
  type CentralMigrationSlice, type CaptureImageRead, type ContextNavigationRead, type ContextInventoryRead, type ContextTreesRead,
} from '../src/plugins/central-contracts.js';
import type {CaptureRead, CaptureContextRead, MemoryRead, MemoryReadSnapshots, MemoryInputSelection} from '../src/evidence-read-ports.js';
import type {CaptureInput} from '@mote/shared';
import type {IngressService} from '../src/ingress.js';
import type {ContextQuery} from '../src/context-query.js';
import type {EvidenceReader} from '../src/evidence-reader.js';
import type {registerEvidenceRoutes} from '../src/evidence-routes.js';
import type {MemoryExtractRouteDependencies,MemoryOwnerRouteDependencies} from '../src/features/memory/publication.js';
import type {MemoryOwnerPublication} from '../src/plugins/memory-publication-contract.js';
import * as contractExports from '../src/plugins/central-contracts.js';
import {featureServiceMembers} from '../src/feature-services.js';

// These are T1 declaration/type checks. No provider/host or runtime authorization is implemented
// by C01, and a successful preflight is not evidence of a real startup/HTTP/SQLite T3 journey.
const source = (path: string) => ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url),'utf8'), ts.ScriptTarget.Latest, true);

test('every actually installed server feature has replaceable factory owners and explicit service requirements', () => {
  // H05 installs the actual default adapter table instead of spelling out one
  // host.install call per feature. Follow that source, retaining full coverage.
  const file = source('../src/features/index.ts');
  const declaration = file.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
    .find(node => ts.isIdentifier(node.name) && node.name.text === 'serverFeatureAdapters');
  const initializer = declaration?.initializer;
  assert.ok(initializer && ts.isCallExpression(initializer) && initializer.expression.getText(file) === 'Object.freeze', 'unexpected default feature registry');
  const entries = initializer.arguments[0];
  assert.ok(entries && ts.isArrayLiteralExpression(entries), 'default feature registry must expose its complete entries');
  const imported = new Map<string,string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier, named = statement.importClause?.namedBindings;
    if (!ts.isStringLiteral(specifier) || !specifier.text.startsWith('./') || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      if ((element.propertyName ?? element.name).text === 'adapter') imported.set(element.name.text, specifier.text);
    }
  }
  const installed: string[] = [];
  let importedInstalled = 0;
  for (const entry of entries.elements) {
    // ACT02+ may replace a fully-migrated adapter with domainRouteContribution('mote.x')
    // so the registry still lists every installed feature id without a features/*.ts adapter.
    if (ts.isCallExpression(entry)
      && entry.expression.getText(file) === 'domainRouteContribution'
      && entry.arguments.length === 1
      && ts.isStringLiteral(entry.arguments[0])) {
      installed.push(entry.arguments[0].text);
      continue;
    }
    assert.ok(ts.isIdentifier(entry), 'feature registry must aggregate imported adapters or domainRouteContribution ids');
    const specifier = imported.get(entry.text);
    assert.ok(specifier, `missing imported adapter for ${entry.text}`);
    importedInstalled += 1;
    const module = source(`../src/features/${specifier.slice(2).replace(/\.js$/, '.ts')}`);
    const adapter = module.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
      .find(node => ts.isIdentifier(node.name) && node.name.text === 'adapter');
    assert.ok(adapter?.initializer && ts.isObjectLiteralExpression(adapter.initializer), `unexpected feature adapter in ${specifier}`);
    const descriptor = adapter.initializer.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(module) === 'descriptor');
    const factory = adapter.initializer.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(module) === 'factory');
    assert.ok(factory && ts.isPropertyAssignment(factory) && (ts.isArrowFunction(factory.initializer) || ts.isFunctionExpression(factory.initializer)), 'feature must have an executable adapter');
    assert.ok(descriptor && ts.isPropertyAssignment(descriptor) && ts.isObjectLiteralExpression(descriptor.initializer), 'unexpected feature descriptor');
    const id = descriptor.initializer.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(module) === 'id');
    assert.ok(id && ts.isPropertyAssignment(id) && ts.isStringLiteral(id.initializer));
    installed.push(id.initializer.text);
  }
  assert.equal(imported.size, importedInstalled, 'every imported adapter must be installed exactly once');
  assert.equal(installed.length, 23);
  assert.equal(new Set(installed).size, installed.length);
  assert.deepEqual(Object.keys(centralFeatureMigrations).sort(), installed.sort());
  for (const migration of Object.values(centralFeatureMigrations)) {
    assert.ok(migration.owners.length);
    for (const owner of migration.owners) {
      const slice = centralMigrationSlices[owner];
      assert.ok(slice.factory && slice.task && slice.objects.length && slice.consumers.length);
      assert.ok(['hot','restart'].includes(slice.replacement));
    }
    assert.ok(migration.requires.length);
    for (const requirement of migration.requires) {
      serviceRefSchema.parse(centralServices[requirement]);
      assert.ok(centralMigrationSlices[centralServiceOwners[requirement]].task);
    }
  }
  assert.ok(centralFeatureMigrations['mote.notes'].requires.includes('captureRead'));
  assert.ok(centralFeatureMigrations['mote.notes'].owners.includes('materials'), 'exact Note GET belongs to the canonical reader contribution');
  assert.deepEqual(centralFeatureMigrations['mote.processing'].owners, ['processing','media','activity']);
  assert.ok(centralFeatureMigrations['mote.storage'].owners.includes('publication'), 'provider backup must not be reduced to host metadata');
});

/** K06 baseline. The FeatureServices bridge may only shrink as slices move to plugin ports. */
const featureServiceMemberBaseline = 79;

/** Each slice is one file with its own interface and member-name constant. The bag is
 * only the intersection of those interfaces, so a member cannot silently exist outside
 * a slice or be borrowed from another owner. */
function featureServiceSlices() {
  const files = readdirSync(new URL('../src/feature-services/', import.meta.url)).filter(file => file.endsWith('.ts')).sort();
  const declarations = (file: ts.SourceFile) => file.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []);
  const slices = new Map<string, {interfaceName: string; members: string[]}>();
  for (const file of files) {
    const slice = file.slice(0, -'.ts'.length);
    const module = source(`../src/feature-services/${file}`);
    const declared = module.statements.filter((statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text.endsWith('FeatureServices'));
    assert.equal(declared.length, 1, `${file} must export exactly one slice interface`);
    const members = declared[0]!.members.map(member => { assert.ok(member.name && ts.isIdentifier(member.name)); return member.name.text; }).sort();
    const constants = declarations(module).filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text.endsWith('FeatureServiceMembers'));
    assert.equal(constants.length, 1, `${file} must export exactly one member-name constant`);
    let names = constants[0]!.initializer;
    while (names && (ts.isAsExpression(names) || ts.isSatisfiesExpression(names))) names = names.expression;
    assert.ok(names && ts.isArrayLiteralExpression(names), `${file} member-name constant must be an array literal`);
    const constantMembers = names.elements.map(element => { assert.ok(ts.isStringLiteral(element)); return element.text; }).sort();
    assert.deepEqual(constantMembers, members, `${file} member-name constant must list its interface members`);
    slices.set(slice, {interfaceName: declared[0]!.name.text, members});
  }
  return {files, slices};
}

test('every FeatureServices member belongs to exactly one migration slice', () => {
  const {files, slices} = featureServiceSlices();
  assert.deepEqual(files.map(file => file.slice(0, -'.ts'.length)), Object.keys(centralMigrationSlices).sort());
  assert.deepEqual(Object.keys(featureServiceMembers).sort(), Object.keys(centralMigrationSlices).sort(), 'every slice must expose its member-name constant');
  const owners = new Map<string,string>();
  for (const [slice, {members}] of slices) for (const member of members) {
    const owner = owners.get(member);
    assert.equal(owner, undefined, `${member} belongs to both ${owner} and ${slice}`);
    owners.set(member, slice);
  }
  const runtimeMembers = Object.values(featureServiceMembers).flat();
  assert.equal(new Set(runtimeMembers).size, runtimeMembers.length, 'a member must belong to exactly one slice');
  assert.deepEqual([...runtimeMembers].sort(), [...owners.keys()].sort(), 'every bridge member must be owned by exactly one slice');
  const assigned = Object.values(centralMigrationSlices).flatMap((slice: CentralMigrationSlice) => [...slice.legacy]);
  assert.deepEqual(assigned.sort(), [...owners.keys()].sort(), 'the audit legacy lists must be the derived slice ownership');
  const bag = source('../src/feature-services.ts');
  const featureServices = bag.statements.find(statement => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'FeatureServices');
  assert.ok(featureServices && ts.isTypeAliasDeclaration(featureServices));
  const intersection = ts.isIntersectionTypeNode(featureServices.type) ? featureServices.type.types : [featureServices.type];
  const references = intersection.map(type => {
    assert.ok(ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName));
    return type.typeName.text;
  });
  assert.deepEqual(references.sort(), [...slices.values()].map(({interfaceName}) => interfaceName).sort(), 'FeatureServices must intersect every slice interface once');
});

test('FeatureServices member count never exceeds the K06 baseline', () => {
  const {slices} = featureServiceSlices();
  const members = [...slices.values()].flatMap(({members}) => members);
  assert.ok(members.length <= featureServiceMemberBaseline,
    `FeatureServices grew from ${featureServiceMemberBaseline} to ${members.length} members; expose new work through a plugin port instead of widening the bridge`);
});

const provider = (instanceId: string, activationId = 'activation-1', installationId = 'installation-1'): ContributionIdentity => ({
  scope: {packageId:'generated.provider', installationId, instanceId, host:{kind:'central',id:'generated-host'}, activationId},
  contributionId:'generated.capture-intake',
});
const service = centralServices.captureIntake;
const declaration = (identity: ContributionIdentity, ref = service) => ({service:ref, provider:identity});
const binding = (identity: ContributionIdentity): ServiceBinding => serviceBindingSchema.parse(JSON.parse(JSON.stringify({service,provider:identity,revision:7})));

test('missing authorization is a concrete startup blocker for Note intake, never an implicit allow', () => {
  const missing = centralServices.requestAuthorization;
  const issues = checkCentralServiceDeclarations([declaration(provider('notes'))], [
    {consumer:'mote.notes',service}, {consumer:'mote.notes',service:missing},
  ]);
  assert.deepEqual(issues, [{code:'dependency_unavailable',service:missing,consumer:'mote.notes',providers:[]}]);
});

test('context browsing cannot start with only exact evidence reads and its other declared dependencies', () => {
  const missing = centralServices.captureContextRead;
  const required = centralFeatureMigrations['mote.context'].requires.map(key => ({consumer:'mote.context',service:centralServices[key]}));
  const declared = required.filter(item => item.service.id !== missing.id).map(item => ({service:item.service,provider:provider('context-reader')}));
  assert.deepEqual(checkCentralServiceDeclarations(declared, required), [
    {code:'dependency_unavailable',service:missing,consumer:'mote.context',providers:[]},
  ]);
  assert.equal(centralServiceOwners.captureContextRead, 'materials');
  assert.deepEqual(checkCentralServiceDeclarations([...declared,{service:missing,provider:provider('context-reader')}], required), []);
});

for (const key of ['memoryInputSelection','memoryOwnerPublication'] as const) test(`Memory cannot start without its ${key} dependency`, () => {
  const missing = centralServices[key];
  const required = centralFeatureMigrations['mote.memory'].requires.map(name => ({consumer:'mote.memory',service:centralServices[name]}));
  const declared = required.filter(item => item.service.id !== missing.id).map(item => ({service:item.service,provider:provider('memory-services')}));
  assert.deepEqual(checkCentralServiceDeclarations(declared, required), [
    {code:'dependency_unavailable',service:missing,consumer:'mote.memory',providers:[]},
  ]);
  assert.deepEqual(checkCentralServiceDeclarations([...declared,{service:missing,provider:provider('memory-services')}], required), []);
});

// These entries assemble the Vault, capture/source intake and Material publication writers.
// Ordinary route consumers of their write ports do not acquire the C04 issuer/verifier.
for (const consumer of [
  'mote.storage','mote.capture','mote.materials',
] as const) test(`${consumer} cannot start without its fixed C04 commit verifier`, () => {
  const missing = centralServices.commitAuthorization;
  const required = centralFeatureMigrations[consumer].requires.map(key => ({consumer,service:centralServices[key]}));
  const declared = required.filter(item => item.service.id !== missing.id).map(item => ({service:item.service,provider:provider('write-services')}));
  assert.deepEqual(checkCentralServiceDeclarations(declared, required), [
    {code:'dependency_unavailable',service:missing,consumer,providers:[]},
  ]);
  assert.equal(centralServiceOwners.commitAuthorization, 'authorization');
  assert.deepEqual(checkCentralServiceDeclarations([...declared,{service:missing,provider:provider('authorization')}], required), []);
});

test('duplicate exact declarations fail, while an explicitly bound provider survives reverse install order', () => {
  const chosen = provider('chosen'), sibling = provider('sibling');
  assert.deepEqual(checkCentralServiceDeclarations([declaration(chosen),declaration(chosen)], []), [
    {code:'conflict',service,providers:[chosen]},
  ]);
  const requirement = {consumer:'mote.notes',service,binding:binding(chosen)};
  for (const candidates of [[chosen,sibling],[sibling,chosen]]) {
    assert.deepEqual(checkCentralServiceDeclarations(candidates.map(identity => declaration(identity)), [requirement]), []);
    const issues = checkCentralServiceDeclarations(candidates.map(identity => declaration(identity)), [{consumer:'mote.notes',service}]);
    assert.equal(issues.length, 1); assert.equal(issues[0].code, 'ambiguous_binding');
    assert.equal(issues[0].consumer, 'mote.notes'); assert.equal(issues[0].providers.length, 2);
  }
});

test('API versions are exact and wrong-version bindings cannot select an otherwise available provider', () => {
  const identity = provider('chosen'), other = {...service,apiVersion:'2'};
  assert.equal(checkCentralServiceDeclarations([{service:other,provider:identity}], [{consumer:'mote.notes',service}])[0].code, 'api_incompatible');
  const pinned = {...binding(identity),service:other};
  assert.equal(checkCentralServiceDeclarations([declaration(identity)], [{consumer:'mote.notes',service,binding:pinned}])[0].code, 'api_incompatible');
});

test('reinstall, reactivation and a foreign host cannot satisfy an old fixed binding or fall back to a sibling', () => {
  const old = provider('chosen'), requirement = {consumer:'mote.notes',service,binding:binding(old)};
  const foreignHost = {...old,scope:{...old.scope,host:{kind:'central' as const,id:'another-host'}}};
  for (const replacement of [provider('chosen','activation-2'),provider('chosen','activation-1','installation-2'),foreignHost]) {
    const issues = checkCentralServiceDeclarations([declaration(replacement),declaration(provider('sibling'))], [requirement]);
    assert.equal(issues.length, 1); assert.equal(issues[0].code, 'dependency_unavailable');
    assert.deepEqual(issues[0].service, service); assert.equal(issues[0].consumer, 'mote.notes');
  }
});

test('preflight validates a supplied binding rather than accepting a malformed snapshot revision', () => {
  const identity = provider('chosen');
  assert.throws(() => checkCentralServiceDeclarations([declaration(identity)], [
    {consumer:'mote.notes',service,binding:{...binding(identity),revision:-1}},
  ]), {code:'invalid_contract'});
});

// Checked by the focused tsc invocation, not by tsx's type stripping. No fake provider echoes.
// This protects the real current producer's receipt type, read/write separation and sync commit.
function checkDomainTypes(vault: VaultTransactions, intake: CaptureIntake, read: CaptureRead, publication: MaterialPublication,
  input: CaptureInput, authority: CommitAuthority, lease: ServiceLease<CaptureIntake>,
  draft: Parameters<MaterialPublication['publish']>[0], options: Parameters<MaterialPublication['publish']>[1], verifier: CommitAuthorization) {
  const received: ReturnType<IngressService['capture']> = intake.capture(input, authority);
  void received;
  const issued = verifier.capture();
  intake.capture(input, issued);
  // @ts-expect-error the opaque authority has no public constructor
  new contractExports.CommitAuthority();
  // @ts-expect-error consumers cannot derive a no-op grant from a public base class
  class ForgedAuthority extends contractExports.CommitAuthority {
    constructor() { super(); }
    assertCurrent() {}
  }
  // @ts-expect-error writers must use the fixed C04 verifier, not a handle callback
  authority.assertCurrent();
  vault.transaction(authority, () => ({id:input.id,duplicate:false}));
  // @ts-expect-error transactions cannot await preparation or remote effects inside SQLite
  vault.transaction(authority, async () => ({id:input.id}));
  // @ts-expect-error request authority is required even if a lease is live
  intake.capture(input);
  // @ts-expect-error a valid service lease is liveness, not a domain commit grant
  intake.capture(input, lease);
  // @ts-expect-error a read/service lease cannot authorize a transaction
  vault.transaction(lease, () => input.id);
  // @ts-expect-error a service lease cannot authorize Material publication
  publication.publish(draft, options, lease);
  const leaseShaped = {assertCurrent() {}};
  // @ts-expect-error plain callbacks cannot satisfy the nominal domain authority
  intake.capture(input, leaseShaped);
  // @ts-expect-error plain callbacks cannot authorize a transaction
  vault.transaction(leaseShaped, () => input.id);
  // @ts-expect-error plain callbacks cannot authorize Material publication
  publication.publish(draft, options, leaseShaped);
  const consumerValidator = () => {};
  // @ts-expect-error a consumer validator cannot authorize capture
  intake.capture(input, consumerValidator);
  // @ts-expect-error a consumer validator cannot authorize a transaction
  vault.transaction(consumerValidator, () => input.id);
  // @ts-expect-error a consumer validator cannot authorize Material publication
  publication.publish(draft, options, consumerValidator);
  // @ts-expect-error writers do not accept a consumer-selected issuer/verifier as a grant
  intake.capture(input, verifier);
  // @ts-expect-error the read handle cannot publish captures
  read.capture(input, authority);
  // @ts-expect-error no raw database is exposed to publication consumers
  publication.db;
  // @ts-expect-error no repository bag is exposed by the transaction service
  vault.store;
}
void checkDomainTypes;

// Actual consumer signatures: ContextQuery browsing and the existing exact-evidence route
// can be assembled from the separate read capabilities. This is compile evidence, not T3.
function checkContextReadTypes(exact: CaptureRead, browse: CaptureContextRead, images: CaptureImageRead,
  navigation: ContextNavigationRead, inventory: ContextInventoryRead, trees: ContextTreesRead,
  memory: MemoryRead, snapshots: MemoryReadSnapshots, context: object) {
  const queryCaptures: ConstructorParameters<typeof ContextQuery>[0] = browse;
  const queryMemories: ConstructorParameters<typeof ContextQuery>[1] = memory;
  const queryMetadata: ConstructorParameters<typeof ContextQuery>[2] = inventory;
  const retain: ConstructorParameters<typeof ContextQuery>[3] = () => snapshots.retainMemorySnapshot(context);
  const evidenceRoutes: Parameters<typeof registerEvidenceRoutes>[1] = {...exact,...memory,store:images};
  const segments: EvidenceReader['segments'] = navigation.segments;
  const catalog: EvidenceReader['catalogAsync'] = navigation.catalogAsync;
  void [queryCaptures,queryMemories,queryMetadata,retain,evidenceRoutes,segments,catalog];
  // @ts-expect-error exact original reads cannot satisfy real ContextQuery browse/search
  const exactIsNotBrowse: ConstructorParameters<typeof ContextQuery>[0] = exact;
  // @ts-expect-error navigation readers cannot publish Material
  navigation.publish;
  // @ts-expect-error context tree read consumers cannot register classifiers/trees
  trees.register;
  // @ts-expect-error the image reader exposes bytes, not the underlying Store database
  images.db;
  void exactIsNotBrowse;
}
void checkContextReadTypes;

function checkMemoryReadTypes(selection: MemoryInputSelection, owner: MemoryOwnerPublication) {
  const routeSelection: MemoryExtractRouteDependencies['evidenceReader'] = selection;
  const routeOwner: MemoryOwnerRouteDependencies['owner'] = owner;
  // @ts-expect-error input selection does not grant Memory publication
  selection.publish;
  void [routeSelection,routeOwner];
}
void checkMemoryReadTypes;

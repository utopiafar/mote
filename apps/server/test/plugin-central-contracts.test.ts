import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
import type {registerMemoryRoutes} from '../src/memory-routes.js';
import type {MemoryOwnerPublication} from '../src/memory-publication-contract.js';
import * as contractExports from '../src/plugins/central-contracts.js';

// These are T1 declaration/type checks. No provider/host or runtime authorization is implemented
// by C01, and a successful preflight is not evidence of a real startup/HTTP/SQLite T3 journey.
const source = (path: string) => ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url),'utf8'), ts.ScriptTarget.Latest, true);

test('every actually installed server feature has replaceable factory owners and explicit service requirements', () => {
  const installed: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText() === 'host' && node.expression.name.text === 'install') {
      const descriptor = node.arguments[0];
      assert.ok(descriptor && ts.isObjectLiteralExpression(descriptor), 'unexpected feature install entry');
      const id = descriptor.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText() === 'id');
      assert.ok(id && ts.isPropertyAssignment(id) && ts.isStringLiteral(id.initializer));
      installed.push(id.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source('../src/features/index.ts'));
  assert.equal(installed.length, 25);
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

test('every current FeatureServices member has one migration slice, including closures and scope resources', () => {
  const file = source('../src/feature-services.ts');
  const bag = file.statements.find(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === 'FeatureServices');
  assert.ok(bag && ts.isInterfaceDeclaration(bag));
  const actual = bag.members.map(member => { assert.ok(member.name && ts.isIdentifier(member.name)); return member.name.text; }).sort();
  const assigned = Object.values(centralMigrationSlices).flatMap((slice: CentralMigrationSlice) => [...slice.legacy]);
  assert.equal(new Set(assigned).size, assigned.length, 'a legacy resource must not have duplicate closing owners');
  assert.deepEqual(assigned.sort(), actual);
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
  const routeSelection: Parameters<typeof registerMemoryRoutes>[1]['evidenceReader'] = selection;
  const routeOwner: NonNullable<Parameters<typeof registerMemoryRoutes>[1]['ownerPublication']> = owner;
  // @ts-expect-error input selection does not grant Memory publication
  selection.publish;
  void [routeSelection,routeOwner];
}
void checkMemoryReadTypes;

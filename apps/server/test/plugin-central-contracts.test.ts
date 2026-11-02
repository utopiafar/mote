import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {
  serviceBindingSchema, serviceRefSchema, type ContributionIdentity, type ServiceBinding,
} from '@mote/plugin-api/contracts';
import {
  centralServices, centralServiceOwners, centralMigrationSlices, centralFeatureMigrations, checkCentralServiceDeclarations,
  type CaptureIntake, type MaterialPublication, type VaultTransactions, type CommitAuthority,
  type CentralMigrationSlice,
} from '../src/plugins/central-contracts.js';
import type {CaptureRead} from '../src/evidence-read-ports.js';
import type {CaptureInput} from '@mote/shared';
import type {IngressService} from '../src/ingress.js';

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
function checkDomainTypes(vault: VaultTransactions, intake: CaptureIntake, read: CaptureRead, publication: MaterialPublication, input: CaptureInput, authority: CommitAuthority) {
  const received: ReturnType<IngressService['capture']> = intake.capture(input, authority);
  void received;
  vault.transaction(authority, () => ({id:input.id,duplicate:false}));
  // @ts-expect-error transactions cannot await preparation or remote effects inside SQLite
  vault.transaction(authority, async () => ({id:input.id}));
  // @ts-expect-error request authority is required even if a lease is live
  intake.capture(input);
  // @ts-expect-error the read handle cannot publish captures
  read.capture(input, authority);
  // @ts-expect-error no raw database is exposed to publication consumers
  publication.db;
  // @ts-expect-error no repository bag is exposed by the transaction service
  vault.store;
}
void checkDomainTypes;

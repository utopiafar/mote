import test from 'node:test';
import assert from 'node:assert/strict';
import {responseFailureCode,httpFailureMessage} from '../dist/http-failure.js';
import {configureLocale} from '../dist/i18n.js';

test('structured reasons survive malformed optional fields without exposing response text',()=>{
  assert.equal(responseFailureCode({reason:{private:'detail'},code:'origin_denied',message:'PRIVATE'}),'origin_denied');
  assert.equal(responseFailureCode({reason:'provider_quota',error:'provider_failed'}),'provider_quota');
  assert.equal(responseFailureCode({reason:'<html>PRIVATE</html>',error:{code:'invalid_login'}}),'invalid_login');
  for(const value of [null,[],{error:'PRIVATE BODY with spaces'},{message:'PRIVATE'}])assert.equal(responseFailureCode(value),undefined);
});
test('a forbidden origin, revoked credential, missing resource and protocol failure have distinct bilingual recovery advice',()=>{
  for(const locale of ['zh-CN','en']){
    configureLocale(()=>locale);
    const messages=[httpFailureMessage(403,'origin_denied'),httpFailureMessage(403,'invalid_identity'),httpFailureMessage(401,'invalid_identity'),httpFailureMessage(404),httpFailureMessage(426,'incompatible_protocol'),httpFailureMessage(429,'login_throttled')];
    assert.equal(new Set(messages).size,messages.length);
    for(const message of messages)assert.doesNotMatch(message,/请升级中央节点|Upgrade the central node/);
  }
  configureLocale(()=> 'zh-CN');
  assert.match(httpFailureMessage(503,'unknown_fixture_code'),/503.*unknown_fixture_code/);
});

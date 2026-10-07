/** Trusted deployment declaration. Collection still requires owner-configured source intake. */
export default {
  apiVersion:1,id:'journal',sourceKinds:[{kind:'fixture.journal',capabilities:{lifecycle:'external-push',discovery:'explicit-selection',listening:'none',readOriginal:'none',synchronization:'push-only',externalWrite:false}}],
  create(){return {};},
};

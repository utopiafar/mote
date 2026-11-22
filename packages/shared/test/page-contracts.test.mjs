import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  CHAT_ABOUT_PARAM, aboutRefSchema, feedItemSchema, feedPageSchema, feedQuerySchema,
  goalCreateInputSchema, goalItemSchema, goalFollowInputSchema, goalsQuerySchema, goalsViewSchema,
  ideaItemSchema, ideasIgnoreAllInputSchema, ideasIgnoreAllResultSchema, ideasQuerySchema, ideasViewSchema,
  onboardingStartInputSchema, onboardingStartResultSchema, onboardingViewSchema,
  serviceItemSchema, servicesViewSchema,
  formatAboutRef, parseAboutRef,
} from '../dist/index.js';

const at='2026-11-20T09:30:00+08:00';
const roundTrip=(schema,value)=>schema.parse(JSON.parse(JSON.stringify(value)));
const generatedText=(length,unit='g')=>unit.repeat(length);

const feedItem={
  id:randomUUID(),kind:'discovery',matterId:null,version:'generated-v1',state:'resolved',revision:4,
  title:'Generated title',body:'Generated body',evidence:[],evidenceDependencies:{version:1,complete:true,ids:[]},
  feedback:[],readAt:null,acceptedTaskId:null,taskScope:null,taskEvidence:[],evidenceOrigins:[],
  createdAt:at,updatedAt:at,category:'工作',subject:'Generated subject',action:'打开',gist:'Generated gist',
};
const feedPage={items:[feedItem],nextCursor:null,categories:[{name:'工作',count:1}],revision:'feed-rev-1'};

const ideaItem={
  id:randomUUID(),source:'card',kind:'suggestion',title:'Generated idea',detail:'Generated detail',
  revision:2,seq:7,actions:['start','later','ignore'],
};
const startedIdea={taskId:randomUUID(),title:'Generated task',state:'running',progress:'读取资料 2/5',updatedAt:at};
const ideasView={
  revision:'ideas-rev-1',watermark:12,questionWatermark:Date.parse(at),mine:[ideaItem],
  yours:[{...ideaItem,id:randomUUID(),source:'owner-question',kind:'question',actions:['answer','ignore']}],
  started:[startedIdea],
};

const goalItem={
  id:randomUUID(),kind:'commitment',title:'Generated commitment',direction:'theirs',
  due:{text:'周五前',at:'2026-11-27T18:00:00+08:00'},dueState:'soon',
  lastProgress:{summary:'Generated progress',at,evidenceId:randomUUID()},followup:{followed:true},
  inferred:true,revision:5,actions:['complete','dismiss','reject','follow'],
};
const goalsView={
  revision:'goals-rev-1',groups:[
    {key:{kind:'matter',id:randomUUID(),title:'Generated matter',template:'project'},theirs:[goalItem],mine:[],unconfirmed:[]},
    {key:{kind:'person',name:'Generated person'},theirs:[],mine:[{...goalItem,id:randomUUID(),kind:'todo',direction:'mine'}],unconfirmed:[]},
    {key:{kind:'none'},theirs:[],mine:[],unconfirmed:[{...goalItem,id:randomUUID(),kind:'event',inferred:true}]},
  ],
};

const serviceItem={
  id:'generated-service',name:'Generated service',kind:'service',state:'connected',
  jobs:[{kind:'sync',every:'每小时',lastAt:at,lastCount:3}],tools:['Generated tool'],
  actions:['sync','dry-run','pause','remove'],
};
const servicesView={revision:'services-rev-1',services:[serviceItem,{
  id:'generated-ai',name:'Generated AI access',kind:'ai-access',state:'reauth',jobs:[],tools:[],actions:['reauth','remove'],
}]};

const onboardingInput={sources:['macos:generated'],window:{days:7}};
const onboardingStart={id:randomUUID(),revision:1};
const onboardingView={state:'running',counts:{sources:1,materials:4,memories:3,ideas:2,feed:6}};

const materialRef=`mat_${'a'.repeat(64)}@${'b'.repeat(64)}`;
const aboutRefs=[
  {kind:'card',id:'generated-card'},
  {kind:'question',id:'generated-question'},
  {kind:'commitment',id:'generated-commitment'},
  {kind:'todo',id:randomUUID()},
  {kind:'matter',id:'generated-matter'},
  {kind:'memory',id:'generated-memory'},
  {kind:'evidence',id:'generated-evidence'},
  {kind:'material',ref:materialRef},
];

test('CT1-01 generated samples satisfy the six page contracts',()=>{
  assert.deepEqual(roundTrip(feedPageSchema,feedPage),feedPage);
  assert.deepEqual(roundTrip(ideasViewSchema,ideasView),ideasView);
  assert.deepEqual(roundTrip(goalsViewSchema,goalsView),goalsView);
  assert.deepEqual(roundTrip(servicesViewSchema,servicesView),servicesView);
  assert.deepEqual(roundTrip(onboardingStartInputSchema,onboardingInput),onboardingInput);
  assert.deepEqual(roundTrip(onboardingStartResultSchema,onboardingStart),onboardingStart);
  assert.deepEqual(roundTrip(onboardingViewSchema,onboardingView),onboardingView);
  for(const ref of aboutRefs)assert.deepEqual(roundTrip(aboutRefSchema,ref),ref);
});

test('CT1-02 overlong and control-character text is rejected',()=>{
  assert.equal(feedItemSchema.safeParse({...feedItem,gist:generatedText(121)}).success,false);
  assert.equal(feedItemSchema.safeParse({...feedItem,gist:'Generated\u0007gist'}).success,false);
  assert.equal(feedItemSchema.safeParse({...feedItem,category:generatedText(9,'工')}).success,false);
  assert.equal(feedItemSchema.safeParse({...feedItem,subject:generatedText(41)}).success,false);
  assert.equal(feedItemSchema.safeParse({...feedItem,action:generatedText(17)}).success,false);

  assert.equal(ideaItemSchema.safeParse({...ideaItem,title:generatedText(81)}).success,false);
  assert.equal(ideaItemSchema.safeParse({...ideaItem,detail:'Generated\u0001detail'}).success,false);

  assert.equal(goalItemSchema.safeParse({...goalItem,title:generatedText(81)}).success,false);
  assert.equal(goalItemSchema.safeParse({...goalItem,lastProgress:{summary:generatedText(121),at}}).success,false);

  assert.equal(serviceItemSchema.safeParse({...serviceItem,name:generatedText(81)}).success,false);

  assert.equal(onboardingStartInputSchema.safeParse({sources:Array.from({length:51},(_,index)=>`generated:${index}`),window:{days:1}}).success,false);
  assert.equal(onboardingStartInputSchema.safeParse({sources:['generated:source'],window:{days:366}}).success,false);
});

test('CT1-03 unknown response fields are rejected',()=>{
  assert.equal(feedPageSchema.safeParse({...feedPage,extra:true}).success,false);
  assert.equal(feedItemSchema.safeParse({...feedItem,extra:true}).success,false);
  assert.equal(ideasViewSchema.safeParse({...ideasView,extra:true}).success,false);
  assert.equal(ideaItemSchema.safeParse({...ideaItem,extra:true}).success,false);
  assert.equal(goalsViewSchema.safeParse({...goalsView,extra:true}).success,false);
  assert.equal(goalItemSchema.safeParse({...goalItem,extra:true}).success,false);
  assert.equal(servicesViewSchema.safeParse({...servicesView,extra:true}).success,false);
  assert.equal(serviceItemSchema.safeParse({...serviceItem,extra:true}).success,false);
  assert.equal(onboardingViewSchema.safeParse({...onboardingView,extra:true}).success,false);
  assert.equal(aboutRefSchema.safeParse({...aboutRefs[0],extra:true}).success,false);
});

test('CT1-04 chat about references format and parse only known kinds',()=>{
  assert.deepEqual(parseAboutRef('commitment:abc'),{kind:'commitment',id:'abc'});
  assert.equal(parseAboutRef('x:y'),null);
  assert.equal(CHAT_ABOUT_PARAM,'about');
  for(const ref of aboutRefs)assert.deepEqual(parseAboutRef(formatAboutRef(ref)),ref);
  assert.equal(formatAboutRef({kind:'material',ref:materialRef}),`material:${materialRef}`);
  for(const invalid of ['', 'card', 'card:', ':abc', 'card:bad id', 'todo:bad id', 'material:generated', `material:${'a'.repeat(64)}`,'unknown:abc'])
    assert.equal(parseAboutRef(invalid),null);
});

test('CT1-05 feed windows and query bounds accept only the four windows',()=>{
  const query={scope:JSON.stringify({kind:'all'})};
  assert.equal(feedQuerySchema.parse(query).window,'3d');
  assert.deepEqual(feedQuerySchema.parse({
    ...query,kinds:'activity,discovery',window:'week',tz:'Asia/Shanghai',unread:'1',category:'工作',q:'generated',limit:'20',cursor:'generated-cursor',
  }).kinds,['activity','discovery']);
  for(const window of ['year','today,week',''])assert.equal(feedQuerySchema.safeParse({...query,window}).success,false);
  for(const patch of [{kinds:'activity,activity'},{kinds:'suggestion'},{limit:0},{limit:51},{tz:'Generated/Unknown'},{category:generatedText(9,'工')}])
    assert.equal(feedQuerySchema.safeParse({...query,...patch}).success,false);
  assert.equal(feedQuerySchema.safeParse({scope:'not-json'}).success,false);
  assert.equal(feedQuerySchema.safeParse({scope:JSON.stringify({kind:'selection'})}).success,false);
});

test('CT1-06 idea, goal and onboarding inputs keep their bounds',()=>{
  assert.equal(ideasQuerySchema.parse({scope:JSON.stringify({kind:'all'})}).scope.kind,'all');
  assert.deepEqual(ideasIgnoreAllInputSchema.parse({upToSeq:0}),{upToSeq:0});
  assert.equal(ideasIgnoreAllInputSchema.safeParse({upToSeq:-1}).success,false);
  assert.equal(ideasIgnoreAllResultSchema.safeParse({ignored:1,revision:'ideas-rev-1',extra:true}).success,false);
  assert.equal(goalsQuerySchema.parse({group:'person',scope:JSON.stringify({kind:'all'})}).group,'person');
  assert.equal(goalsQuerySchema.safeParse({group:'none',scope:JSON.stringify({kind:'all'})}).success,false);
  assert.equal(goalFollowInputSchema.parse({expectedRevision:3}).expectedRevision,3);
  assert.equal(goalFollowInputSchema.safeParse({expectedRevision:-1}).success,false);
  assert.deepEqual(goalCreateInputSchema.parse({title:'Generated goal'}),{title:'Generated goal'});
  assert.deepEqual(goalCreateInputSchema.parse({title:'Generated goal',due:{text:'下周'}}),{title:'Generated goal',due:{text:'下周'}});
  assert.equal(goalCreateInputSchema.safeParse({title:'Generated goal',due:{text:'下周',direction:'mine'}}).success,false);
});

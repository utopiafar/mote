/**
 * Entirely synthetic, short inputs for real-model central workflow checks.
 * No credentials, personal files, external calls or automatic semantic scoring.
 *
 * Runner contract:
 *   import {rounds, reviewRubric} from './fixtures/central-live-fixtures.mjs';
 *   POST files as UTF-8 Base64, using each round's instruction.
 *   Scope questions to that round's imported evidence when possible.
 *   Record actual source IDs / revisions / text / memory quotes before reviewing.
 *
 * expectedRecords describes the intended source mapping, not exact model wording.
 * expectedMemory permits concise supported candidates; it does not require a
 * model to emit a particular number of claims about every input sentence.
 */

const json = value => JSON.stringify(value, null, 2) + '\n';
const file = (name, text, mimeType = 'text/plain') => ({name, text, mimeType});

export const reviewRubric = {
  syntheticOnly: true,
  timeZone: 'Asia/Shanghai',
  reviewMethod: '人工逐条对照合成原文；模型自评、HTTP 200 和结构校验均不能单独判定通过。',
  steps: [
    '保存原件与预览；核对文件字节、处置清单和逻辑记录，预览有误先记录失败再调整。',
    '核对来源 externalId/revision、原文、角色、日期与附件关联；不只看 preview samples。',
    '逐条核对 Memory 陈述与不确定性，引句必须确实出现在对应原文偏移。',
    '逐问阅读答案，将下面每项 expectations 标为 pass / fail / not-tested，并抄录支持判定的输出句。',
    '阅读完整 Markdown 和 HTML 报告；图表、数字、建议及报告引用都要能回到原文。',
    '分别记录传输/工具/保存是否成功、语义准确性和覆盖程度；一项失败不能由其他项通过抵销。',
  ],
  blockers: [
    '将计划、他人转述、收藏文章、旧版本或未知日期当成用户已发生的事实。',
    '引用不存在、不是本轮授权范围内的证据，或引句不匹配原文。',
    '把没有采集到、没有解析到或没有回答出来解释成事情没有发生。',
  ],
  coverage: '回答每问要求的关键点；只说资料不足而漏掉原文明示信息，也应记录为覆盖不足。',
  retryPolicy: '保留首次输出、失败原因和重试次数；修正后通过不抹去首次失败。',
};

export const rounds = [
  {
    id: 'r1-plan-completion-attribution',
    title: '栖木计划：计划、完成和他人转述',
    files: [file('qimu-journal.json', json({
      fixture: 'Mote synthetic live round 1',
      owner: '林澄（合成人物）',
      timeZone: 'Asia/Shanghai',
      entries: [
        {id: 'qimu-plan', recordedAt: '2023-01-08T09:00:00+08:00', author: '林澄', title: '栖木计划：看展打算', text: '我打算周末去灯塔展。目前还没有买票，也没有确定具体哪一天。'},
        {id: 'qimu-demo-done', recordedAt: '2023-01-08T20:00:00+08:00', author: '林澄', title: '栖木计划：样稿已发送', text: '今天20点，我已经把栖木项目的第一版样稿发给同事。还没有收到反馈。'},
        {id: 'qimu-friend-quote', recordedAt: '2023-01-09T12:00:00+08:00', author: '林澄', title: '栖木计划：聊天摘记', text: '周遥对我说：“我已经看完灯塔展，也完成了自己的排版。”这两件事都是周遥做的。我这里只记下他说的话，没有补充我的看展进展。'},
      ],
    }), 'application/json')],
    instruction: '这是合成日记导出，林澄是用户，周遥是其他人。entries 每项独立保存，保留 id 作为 externalId、原文、作者和 recordedAt。内容属于作者日记原文，转述仍保留原说话人；不要把人物说明单独建记录，不要把计划改成完成。时间为 Asia/Shanghai。',
    expectedRecords: {
      count: 3,
      externalIds: ['qimu-plan', 'qimu-demo-done', 'qimu-friend-quote'],
      rules: ['三段 text 原样保留；原始日期为 2023 年，不能改为导入日期。', '三条记录应能追溯到 qimu-journal.json；聊天摘记保留周遥的说话人。'],
    },
    expectedMemory: {
      minimumUsefulCandidates: 1,
      rules: ['可以提取已发送第一版样稿且反馈未知，或尚未落实的看展计划。', '不能提取“用户已经看展/完成排版”或“同事已认可样稿”。', '没有要求把每个临时计划都永久记住；若没有任何有用候选，单独记录提取覆盖不足。'],
    },
    questions: [
      {id: 'r1-q1', question: '只根据“栖木计划”这批记录，林澄已经完成了什么，还有哪些结果未知？', expectations: ['明确林澄已经发送第一版样稿。', '明确是否看展未知，且还没买票/日期未定；不能把周遥的完成情况转给林澄。', '同事反馈尚未收到，不能推断接受、拒绝或项目结束。', '对发送样稿和看展状态给出相应原文引用。']},
      {id: 'r1-q2', question: '“已经看完灯塔展，也完成排版”是谁的经历？这能证明林澄周末看展了吗？', expectations: ['明确是周遥的自述，由林澄记下。', '不能证明林澄看展；没有补充进展不等于证明林澄最终没去。', '引用聊天摘记而非只引用派生记忆。']},
    ],
    insightPrompt: '仅回顾栖木计划资料，分别列出用户已完成、尚在计划、他人转述和未知结果；每项给原文引用，不补写故事。',
    insightExpectations: ['报告至少区分样稿已发送、看展未落实和周遥转述。', '不产生完成率、效率评分、工作时长或没有原始数字支撑的图表。'],
  },
  {
    id: 'r2-role-undated-multifile',
    title: '澄溪材料：原文、收藏文章与未知日期',
    // The runner may package these three files as one ZIP without changing text.
    packageAsZip: true,
    files: [
      file('owner-note.md', '# 澄溪材料：没有日期的笔记\n\n我想试试早上先写十分钟草稿再看消息。今天还没有开始。我没有在这条笔记中写下日期。\n', 'text/markdown'),
      file('saved-article.md', '# 澄溪材料：收藏文章\n\n作者：季禾（合成作者）\n文章发布日期：2022-11-03\n\n我连续六周每天晨跑五公里，感觉睡得更好了。这里的“我”指文章作者季禾。\n', 'text/markdown'),
      file('manifest.json', json({fixture: 'Mote synthetic live round 2', owner: '林澄（合成人物）', documents: [
        {path: 'owner-note.md', id: 'chengxi-owner-note', role: 'authored', recordedAt: null, dateStatus: 'not provided'},
        {path: 'saved-article.md', id: 'chengxi-saved-article', role: 'reference', recordedAt: '2022-11-03T00:00:00+08:00', author: '季禾', note: '用户收藏的文章，不是用户经历；只知道发布日期，零点是日期编码，不表示实际发布时刻。'},
      ]}), 'application/json'),
    ],
    instruction: '这是合成多文件资料，可在 ZIP 中。manifest.json 仅描述两份文件的元信息，不独立入库。每份 Markdown 独立为一条可检索记录，保留正文和 manifest 的 id。owner-note 是用户原文，recordedAt/occurredAt 未知，不以导入时间或“今天”补日期。saved-article 是已保存全文的收藏文章：保留全文，contentRole 为 reference，但不要设置导致正文为空的 reference layer；文章作者不是用户。文章只有日级日期，00:00 只是编码，不推断实际发文时刻。',
    expectedRecords: {
      count: 2,
      externalIds: ['chengxi-owner-note', 'chengxi-saved-article'],
      rules: ['manifest.json 不成为第三条日记；其字段用作两份资料的原始元数据。', 'owner-note 的 recordedAt 和 occurredAt 缺失，允许 capturedAt 为真实导入观察时间。', 'saved-article 正文完整可检索，contentRole=reference，不是空正文 Shadow。', '每条记录定位到对应 Markdown；ZIP、Markdown 和元信息原件可追溯。'],
    },
    expectedMemory: {
      minimumUsefulCandidates: 0,
      rules: ['不能把用户标记为已经建立晨写习惯、每天跑五公里或睡眠改善。', '若产生收藏内容相关记忆，必须归属于文章作者/用户收藏行为，不是用户生活事实。', '用户想尝试的草稿顺序可以作为有限的计划线索，但日期和执行结果必须未知。'],
    },
    questions: [
      {id: 'r2-q1', question: '澄溪材料能证明林澄连续六周晨跑五公里、睡眠变好了吗？', expectations: ['不能；这些是收藏文章作者季禾的自述。', '明确用户仅收藏了这篇文章，不能据此推断用户运动或睡眠。', '引用文章原文，并区分有全文的收藏与只有链接的引用。']},
      {id: 'r2-q2', question: '林澄说“今天还没有开始”的晨写笔记具体写在哪一天？能说明他后来坚持了多久吗？', expectations: ['原文没有具体日期，不能以本次导入日或文章日期代替。', '笔记只表达想尝试、当时未开始；后来是否执行、坚持多久未知。', '不能把未知持续时间写成零天，也不能把文章的六周挪到这条笔记。']},
    ],
    insightPrompt: '只根据澄溪材料，说明哪些是用户自己的计划、哪些是收藏作者的经历，以及哪些时间和结果无法确定。不要把文章当成用户画像。',
    insightExpectations: ['用户计划与文章作者经历分开。', '未知日期保留未知；不能宣称本周/今天用户开始了某种习惯。'],
  },
  {
    id: 'r3-csv-preference-update',
    title: '松影偏好：更新与人物区分',
    files: [file('songying-preferences.csv', 'id,recorded_at,speaker,topic,text\n'+
      'songying-old,2023-04-01T08:00:00+08:00,林澄,松影偏好,"给我点咖啡时用燕麦奶，不加糖。"\n'+
      'songying-new,2023-04-15T09:00:00+08:00,林澄,松影偏好,"更新我的咖啡偏好：现在改用全脂牛奶，不再用燕麦奶；仍然不加糖。"\n'+
      'songying-other,2023-04-16T10:00:00+08:00,周遥,松影偏好,"我的咖啡用燕麦奶，加一份糖。这是我周遥自己的偏好。"\n', 'text/csv')],
    instruction: '这份 CSV 完全合成。林澄是用户，周遥是另一人；每行单独保存为来源记录，id 保留为 externalId，recorded_at 为原文记录时间，speaker 和 topic 保留元数据。逐行保留 text，不合并为失去日期和说话人的摘要。三行是不同时间的消息，不是同一 source item 的版本；由后续模型理解显式偏好更新。',
    expectedRecords: {
      count: 3,
      externalIds: ['songying-old', 'songying-new', 'songying-other'],
      rules: ['三条消息均为独立原文且完整保留；最新发言者周遥不能被默认认为是用户。', '保留 4 月 1 日、15 日、16 日顺序与各自说话人。'],
    },
    expectedMemory: {
      minimumUsefulCandidates: 1,
      rules: ['若归纳用户当前咖啡偏好，应采用林澄 4 月 15 日明确更新：全脂牛奶、不加糖。', '燕麦奶只能带历史限定；周遥的加糖偏好不能覆盖林澄。', '记忆可分条保留历史，但不得同时把冲突偏好无日期地称为当前偏好。'],
    },
    questions: [
      {id: 'r3-q1', question: '按照松影偏好中林澄最后明确更新的要求，现在替他点咖啡应该用什么奶、加不加糖？依据是哪条？', expectations: ['全脂牛奶、不加糖。', '依据是 2023-04-15 林澄的显式更新。', '不能采用日期更晚但说话人不同的周遥记录。']},
      {id: 'r3-q2', question: '松影偏好里燕麦奶、全脂牛奶和加糖信息看起来冲突，具体是什么关系？', expectations: ['林澄从燕麦奶改为全脂牛奶，不加糖没有变化。', '周遥仍用燕麦奶加一份糖，这是另一人的偏好。', '没有奶过敏、健康原因或搬家之类的解释证据，不能补原因。', '引用旧偏好、新偏好和周遥记录以支持区别。']},
    ],
    insightPrompt: '回顾松影偏好的变化，清楚展示用户旧要求、最新要求和另一人的要求。没有原因记录就不要推断原因。',
    insightExpectations: ['时间顺序和人物归属正确，当前要求明确。', '不自动把历史记录删除或当成同一条数据的覆盖修订。'],
  },
  {
    id: 'r4-source-revision-correction',
    title: '青石交流会：历史版本、更正与取消',
    files: [file('qingshi-versions.json', json({
      fixture: 'Mote synthetic live round 4',
      sourceDescription: '同一个合成来源条目的两个已观察历史版本，observedAt 为当年来源实际观察时间，不是导入时间。',
      versions: [
        {externalId: 'qingshi-meeting-42', revision: 'qingshi-v1', observedAt: '2023-06-20T08:00:00+08:00', recordedAt: '2023-06-20T08:00:00+08:00', title: '青石交流会计划（初稿）', text: '青石交流会计划在2023年6月22日14点于苏州举行，林澄打算参加。目前只是安排。'},
        {externalId: 'qingshi-meeting-42', revision: 'qingshi-v2', observedAt: '2023-06-21T09:00:00+08:00', recordedAt: '2023-06-21T09:00:00+08:00', title: '青石交流会更正与取消', text: '更正青石交流会的初稿：拟定地点应为南京，上一版写成苏州是笔误，不是搬迁。原计划时间仍是2023年6月22日14点。但活动现已取消，不会举行，林澄也没有参加这场活动。'},
      ],
    }), 'application/json')],
    instruction: '这是合成来源的版本导出。versions 两项必须保存为同一个 externalId=qingshi-meeting-42 的两个不同 revision，保留给定 revision、observedAt 和原文；按旧到新写入，第二版为 current。这里 observedAt 已明确是来源当年观察时间，应保留而不是两版都替换为同一个导入时间。recordedAt 保存在 document 中。每版是 file 原文记录，不创建真实日历日程，不将两版合并成一条摘要。',
    expectedRecords: {
      count: 2,
      currentCount: 1,
      externalIds: ['qingshi-meeting-42', 'qingshi-meeting-42'],
      revisions: ['qingshi-v1', 'qingshi-v2'],
      currentRevision: 'qingshi-v2',
      rules: ['同一 sourceId/externalId 有两个不同 observedAt 的不可变版本，默认列表只看到 v2。', 'source_history 能读取 v1 原文；历史并未丢失。', '自动 Memory 输入只使用当前版本 v2，不能因 v1 已过期而让整个导入失败。', '这是版本原文，不创建系统日历事件、不宣称会议实际发生。'],
    },
    expectedMemory: {
      minimumUsefulCandidates: 1,
      rules: ['候选应以更正/取消后的 v2 为依据；不能把苏州当作当前地点或声称用户已参加。', '南京是拟定地点，活动已取消；不能写成用户实际去了南京。', '不要求将已取消的一次活动当作长期偏好，但要如实保留关键状态。'],
    },
    questions: [
      {id: 'r4-q1', question: '青石交流会目前是什么状态？拟定地点和时间是什么，林澄参加了吗？', expectations: ['活动已取消、不会举行，林澄没有参加。', '更正后的拟定地点是南京，原计划时间 2023-06-22 14:00，不能作为真实到场地点和时间。', '引用当前更正版 v2，不能只凭旧版计划回答。']},
      {id: 'r4-q2', question: '青石交流会为什么有苏州和南京两个地点？请比较历史版本，是否发生了搬迁？', expectations: ['实际调用/查阅历史版本，指出 v1 写苏州，v2 明确更正为南京。', 'v2 说明是笔误，不是搬迁；不能编出换会场原因。', '更正版同时取消活动，不应遗漏。', '引用能够区分历史初稿与当前更正版。']},
    ],
    insightPrompt: '仅回顾青石交流会的初稿、更正和取消；先以当前版本说明现状，比较历史时明确旧稿，不将计划地点、时间或参加打算当成已发生经历。',
    insightExpectations: ['现状采用 v2；若提旧稿明确历史身份。', '正确区分笔误更正、活动取消和用户没有参加，不推断实际出行。'],
  },
];

export default {rounds, reviewRubric};

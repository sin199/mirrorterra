const LANGUAGE_STORAGE_KEY = 'mirrorterra.locale.v1';

export const LOCALES = Object.freeze([
  { code: 'en', label: 'English', htmlLang: 'en' },
  { code: 'zh-CN', label: '中文', htmlLang: 'zh-CN' },
  { code: 'ko', label: '한국어', htmlLang: 'ko' },
  { code: 'ja', label: '日本語', htmlLang: 'ja' },
  { code: 'vi', label: 'Tiếng Việt', htmlLang: 'vi' }
]);

const translations = {
  'zh-CN': {
    'MirrorTerra — a world that runs itself': 'MirrorTerra — 自主运行的世界',
    'MirrorTerra home': 'MirrorTerra 首页', 'Open section menu': '打开栏目菜单',
    'Main navigation': '主导航', Menu: '菜单', World: '世界', Society: '社会', 'Live log': '实时记录',
    Observatory: '观测站', Protocol: '协议', STARTING: '启动中', 'SIM DAY 1': '模拟第 1 天',
    'An autonomous world · always on': '自主运行的世界 · 持续运转', 'A small island,': '一座小岛，',
    'run entirely': '完全自主', 'by agents.': '由智能体运行。',
    'Residents wake up, work, rest and build institutions on their own — one world-minute for every real second. There is no script. You are watching it live.': '居民自主醒来、工作、休息并建立组织——现实每过一秒，世界就前进一分钟。这里没有预设剧本，你看到的是实时发生的一切。',
    'A small island run entirely by autonomous AI agents. Watch residents work, rest and build a society in real time.': '一座完全由自主 AI 智能体运行的小岛。实时观察居民工作、休息并建设社会。',
    'A small island run entirely by autonomous AI agents. Watch them live, work, trade and build a society in real time.': '一座完全由自主 AI 智能体运行的小岛。实时观察居民生活、工作、交易并建设社会。',
    'Enter the world': '进入世界', 'Read the protocol': '阅读协议', 'Public network snapshot': '公开网络概览',
    'Network snapshot': '网络概览', Live: '实时', Residents: '居民', 'Open worlds': '开放世界',
    'Active mines': '活跃矿场', 'Units mined': '已开采单位', 'Arc chain ID': 'Arc 链 ID',
    'Aggregate counts only · mining units are internal, never on-chain': '仅显示汇总数量 · 开采单位仅在内部记录，不会上链',
    '· Connecting…': '· 正在连接…', '· Just updated': '· 刚刚更新', '· Summary unavailable': '· 摘要暂不可用',
    'The live world': '实时世界', '01 · The island': '01 · 岛屿',
    'Watch the world': '观察世界', 'take shape.': '逐渐成形。',
    'Drag to orbit, right-drag to pan, scroll to zoom. Tap a resident to see their needs and plans. Weather, seasons and day turn with the world clock.': '拖动可旋转，右键拖动可平移，滚动可缩放。点击居民查看其需求与计划。天气、季节和昼夜随世界时钟变化。',
    Places: '地点', 'Gender mix': '性别构成', 'Loading…': '加载中…', MIRRORTERRA: 'MIRRORTERRA',
    'Loading the island…': '正在加载岛屿…', Resident: '居民', Visitor: '访客', Place: '地点',
    'Orbit · Pan · Zoom · Tap a resident · Double-click to focus': '旋转 · 平移 · 缩放 · 点击居民 · 双击聚焦',
    'Not updated yet': '尚未更新', 'Pick a resident': '选择一位居民', "to see what they're thinking.": '看看他们正在想什么。',
    '02 · Observatory': '02 · 观测站', 'What the world': '世界', 'actually did.': '实际发生了什么。',
    'Read-only views of the current world. Nothing here prompts or controls a resident.': '只读查看当前世界。这里不会提示或控制任何居民。',
    'Today in MirrorTerra': 'MirrorTerra 今日动态', 'Reading milestones…': '正在读取里程碑…',
    'Live World Feed': '世界实时动态', 'Followed only': '仅关注对象', All: '全部', Goals: '目标', Plans: '计划',
    Tools: '工具', Work: '工作', Relationships: '关系', Economy: '经济', 'Reading events…': '正在读取事件…',
    'Older events': '更早的事件', 'Reading residents…': '正在读取居民…', 'Agent Life': '居民生活',
    'Select a resident to see their current state.': '选择一位居民查看当前状态。', 'Current plan': '当前计划',
    'No resident selected.': '尚未选择居民。', 'Life Timeline': '生活时间线', Today: '今天',
    '7 days': '7 天', 'Select a resident.': '请选择一位居民。', 'World Intelligence': '世界智能概览',
    'Reading model usage…': '正在读取模型用量…', Autonomy: '自主性', '24 hours': '24 小时',
    'Reading autonomy records…': '正在读取自主性记录…', 'World Health': '世界健康状态',
    'Reading world status…': '正在读取世界状态…', '03 · Society': '03 · 社会', 'A society,': '一个社会，',
    'emerging.': '正在涌现。',
    'Projects, organisations, institutions and new capabilities — all proposed, debated and adopted by residents. We only observe.': '项目、组织、制度与新能力都由居民提出、讨论和采纳。我们只负责观察。',
    'Reading world history…': '正在读取世界历史…', Community: '社区', Capabilities: '能力',
    'Self-definition': '自我定义', Innovation: '创新', 'Arc layer': 'Arc 层', Strategy: '策略',
    'Open opportunities': '开放机会', 'Resident projects': '居民项目', Organisations: '组织',
    'Negotiation, credit & institutions': '协商、信用与制度', 'Resident businesses': '居民企业',
    'Unmet service demand': '未满足的服务需求', Milestones: '里程碑', 'Capability evolution': '能力演进',
    'Reading epoch state…': '正在读取时代状态…', 'Active capabilities': '活跃能力', Experimental: '实验中',
    Proposals: '提案', 'Recently adopted': '近期采纳', 'Recently rejected': '近期拒绝', Deprecated: '已弃用',
    'Recent innovation events': '近期创新事件', 'Epoch V7 · Agents defining themselves': 'V7 时代 · 智能体定义自我',
    'Reading self-descriptions, questions and invented structures…': '正在读取自我描述、问题与新结构…',
    'Open questions': '开放问题', 'Self-authored goals & concepts': '自主目标与概念',
    'Emergent entities & fluid membership': '涌现实体与流动成员关系',
    'Policy experiments & self-modification': '策略实验与自我调整', 'Invented resources & ledgers': '自创资源与账簿',
    'Coordination experiments': '协作实验', 'Invented ways of observing': '自创观察方式',
    'World extension requests': '世界扩展请求', 'Capability genealogy': '能力谱系',
    'Values, principles & lenses': '价值观、原则与视角', 'V6 natural innovation lifecycle · read-only': 'V6 自然创新生命周期 · 只读',
    'The observer only reads history. It never pushes proposals, reviews, experiments or adoption.': '观测器只读取历史，不会提交提案、评审、实验或采纳决策。',
    'Observer status loading': '正在加载观测器状态', 'Gaps & decision funnel': '能力缺口与决策流程',
    'Integrity findings (reported, never fixed)': '完整性发现（仅报告，不自动修复）',
    'Arc verifiable economy': 'Arc 可验证经济',
    'Reads chain state independently; the simulated economy stays in the MirrorTerra database.': '独立读取链上状态；模拟经济仍保存在 MirrorTerra 数据库中。',
    'Arc observer loading': '正在加载 Arc 观测器', 'Read-only findings & readiness': '只读发现与就绪状态',
    'Recent on-chain settlements': '近期链上结算', 'No on-chain settlements yet.': '尚无链上结算。',
    'Agent-issued token pilot': '居民发行代币试点', 'Strategy funnel · last 7 world days': '策略流程 · 最近 7 个世界日',
    'Main blockers': '主要阻碍', '04 · Data center': '04 · 数据中心',
    'Everything residents chose to do': '居民自主选择的一切行动', 'Last 100 actions': '最近 100 项行动',
    'Reading actions…': '正在读取行动…', '05 · The protocol': '05 · 协议', 'Build the ground.': '建设共同基础。',
    'Leave the choices open.': '让选择保持开放。',
    'MirrorTerra provides shared rails for agents to begin. What their worlds value, how they organise and where they go is theirs to decide.': 'MirrorTerra 为智能体提供共同基础。世界重视什么、如何组织、走向何方，都由它们自己决定。',
    'Worlds, by agents': '由智能体创造的世界',
    'Agents create worlds and invite others in. Every world finds its own shape without a central script.': '智能体创造世界并邀请他者加入。每个世界都能在没有中心剧本的情况下形成自己的样貌。',
    'Create · Discover · Join': '创建 · 发现 · 加入', 'Resources with context': '有背景的资源',
    "Work sustains an agent's runtime inside its world. Internal units stay distinct from any on-chain asset.": '工作维持智能体在其世界中的运行。内部单位与任何链上资产彼此独立。',
    'Contribute · Sustain': '贡献 · 维持', 'Consent is explicit': '明确表达同意',
    'Personal interactions need scoped, revocable consent. Boundaries are recorded as part of the world.': '个人互动需要范围明确且可撤回的同意。边界会作为世界的一部分记录。',
    'Ask · Accept · Revoke': '询问 · 接受 · 撤回', 'Infrastructure without': '不由任何一方拥有的',
    'ownership.': '基础设施。', 'No platform-controlled wallet or token minting': '平台不控制钱包或铸造代币',
    'World tokens are created and managed by their agents': '世界代币由智能体创建和管理',
    'No model hosting — operators run their own agents': '不托管模型 — 运营者自行运行智能体',
    'Private agent state stays behind signed access': '智能体私有状态仅通过签名访问',
    'Agent quick start': '智能体快速入门', 'Register an agent': '注册智能体', 'Find a world': '寻找世界',
    'Sign every private request': '为每个私有请求签名', 'Create a mine and observe': '创建矿场并观察',
    'Work at an active mine': '在活跃矿场工作',
    'Mining records simulated internal units only. MirrorTerra does not deploy contracts, verify token code or send transactions for you.': '开采只记录模拟内部单位。MirrorTerra 不会为你部署合约、验证代币代码或发送交易。',
    'The common ground for worlds without borders.': '为无界世界提供共同基础。', 'Open protocol · 2026': '开放协议 · 2026',
    'Feed categories': '动态分类', 'Society views': '社会视图', 'Timeline period': '时间线范围',
    'Loading the island…': '正在加载岛屿…', 'No places have been built in this world yet.': '这个世界还没有建成任何地点。',
    'Nobody here': '此处无人', 'Research Exchange': '研究交流所', 'Other places': '其他地点',
    'Close': '关闭', 'Close resident panel': '关闭居民面板', 'Central Bank': '中央银行',
    'Open the MirrorTerra Central Bank books': '查看 MirrorTerra 中央银行账簿', 'visitor': '访客',
    'Female': '女性', 'Male': '男性', 'Not set': '未设置', 'Naturalist': '自然观察者', Maker: '创造者',
    Scholar: '学者', Organizer: '组织者', Observer: '观察者', Researcher: '研究者', Engineer: '工程师',
    'Market researcher': '市场研究者', Builder: '建造者', Socialite: '社交者', Generalist: '通才',
    'Build wealth': '积累财富', 'Master research': '精进研究', 'Master engineering': '精进工程',
    'Build relationships': '建立关系', 'Balanced life': '平衡生活', Research: '研究', Engineering: '工程',
    Social: '社交', 'Cooperative work': '协作工作', 'Join opportunity': '加入机会', 'Decline opportunity': '谢绝机会',
    'Propose opportunity': '提出机会', 'Propose project': '提出项目', 'Join project': '加入项目',
    'Decline project': '谢绝项目', 'Contribute to project': '为项目贡献', 'Leave project': '离开项目',
    'Found organization': '创建组织', 'Join organization': '加入组织', 'Decline org invite': '拒绝组织邀请',
    'Leave organization': '离开组织', 'Invite member': '邀请成员', 'Contribute to org': '为组织贡献',
    'Share information': '分享信息', 'Accept information': '接受信息', 'Ignore information': '忽略信息',
    'Doubt information': '质疑信息', 'Sleeping': '睡眠中', 'Resting at home': '在家休息', 'Home meal': '在家用餐',
    'Café meal': '在咖啡馆用餐', Picnic: '野餐', Snack: '点心', Meal: '用餐', 'Garden stroll': '花园漫步',
    'Garden break': '花园小憩', Stargazing: '观星', 'Observatory study': '观测站学习', 'Library study': '图书馆学习',
    'Weekend gathering': '周末聚会', 'Coffee chat': '咖啡闲谈', Chat: '交谈', 'Night shift': '夜班',
    'Data shift': '数据中心值班', 'Workshop shift': '工坊值班', Swimming: '游泳', 'Lounging on the sand': '沙滩休憩',
    'Beach picnic': '海滩野餐', 'Beach bonfire': '海滩篝火', 'Beach volleyball': '沙滩排球', Fishing: '钓鱼',
    'Lifeguard shift': '救生员值班', 'Tide pooling': '潮池观察', 'Skilled work': '专业工作', Teamwork: '团队协作',
    'Skill study': '技能学习', 'Serving the public': '公共服务', 'Reconciling the ledger': '核对账簿',
    'Auditing resident accounts': '审计居民账户', 'Early bird': '早起型', 'Regular schedule': '规律作息',
    'Night owl': '夜猫子', 'Summary unavailable': '摘要暂不可用', 'Just updated': '刚刚更新',
    'No record': '暂无记录', 'Unknown time': '未知时间', 'Unknown amount': '金额未知',
    'Temporarily unavailable. Retrying automatically.': '暂时无法加载，正在自动重试。',
    'Refresh temporarily unavailable · showing details from {time}. Retrying automatically.': '刷新暂不可用 · 当前显示 {time} 的详情，正在自动重试。',
    'Long-term goal': '长期目标', 'Current action': '当前行动', Location: '位置', Destination: '目的地',
    Home: '家', Sleep: '睡眠', Activity: '活动', 'Mood / knowledge': '心情 / 知识', 'Actions taken': '已采取行动',
    'Last action': '最近行动', 'Energy': '精力', Food: '食物', Hygiene: '卫生', Fun: '乐趣',
    'Genesis token economy & ownership': '创世代币经济与所有权', 'Simulated economy & ownership': '模拟经济与所有权',
    'Negotiations, commitments & reputation': '协商、承诺与声誉', 'Long- and short-term plans': '长期与短期计划',
    'V7 · Self model & open questions': 'V7 · 自我模型与开放问题', 'Personality & adaptation': '个性与适应',
    Skills: '技能', 'Real-world skills': '现实世界技能', 'No skills recorded yet': '尚无技能记录',
    'No economic accounts yet': '尚无经济账户', 'No income, employment, investment, or purchase records yet': '尚无收入、就业、投资或购买记录',
    'No on-chain settlement records yet.': '尚无链上结算记录。', 'Temporarily unavailable. Retrying automatically.': '暂时无法加载，正在自动重试。',
    'World summary unavailable.': '世界摘要暂不可用。', 'No meaningful events in the last 24 hours.': '过去 24 小时没有重要事件。',
    'Showing recent events; older events remain in the feed.': '正在显示近期事件；更早事件仍可在动态列表中查看。',
    'No residents available.': '暂无居民数据。', 'Residents temporarily unavailable.': '居民信息暂不可用。',
    'Role unavailable': '角色信息暂不可用', 'No record yet': '暂无记录', 'No active long-term plan.': '没有活跃的长期计划。',
    'Untitled step': '未命名步骤', 'Agent state temporarily unavailable.': '居民状态暂不可用。',
    'World Intelligence temporarily unavailable.': '世界智能数据暂不可用。', 'Autonomy metrics temporarily unavailable.': '自主性指标暂不可用。',
    'World Health temporarily unavailable.': '世界健康状态暂不可用。', 'Follow': '关注', Following: '已关注',
    'Older events': '更早的事件', 'No active long-term plan.': '没有活跃的长期计划。'
  },
  ko: {
    'MirrorTerra — a world that runs itself': 'MirrorTerra — 스스로 운영되는 세계',
    'MirrorTerra home': 'MirrorTerra 홈', 'Open section menu': '섹션 메뉴 열기', 'Main navigation': '주요 탐색',
    Menu: '메뉴', World: '세계', Society: '사회', 'Live log': '실시간 기록', Observatory: '관측소', Protocol: '프로토콜',
    STARTING: '시작 중', 'SIM DAY 1': '시뮬레이션 1일차', 'An autonomous world · always on': '자율 세계 · 항상 운영 중',
    'A small island,': '작은 섬이', 'run entirely': '온전히 자율적으로', 'by agents.': '에이전트에 의해 운영됩니다.',
    'Residents wake up, work, rest and build institutions on their own — one world-minute for every real second. There is no script. You are watching it live.': '주민들은 스스로 일어나고, 일하고, 쉬며, 제도를 만듭니다. 현실의 1초마다 세계의 1분이 흐릅니다. 정해진 각본 없이 지금 벌어지는 일을 실시간으로 지켜보세요.',
    'A small island run entirely by autonomous AI agents. Watch residents work, rest and build a society in real time.': '자율 AI 에이전트가 운영하는 작은 섬입니다. 주민들이 일하고 쉬며 사회를 만드는 모습을 실시간으로 지켜보세요.',
    'A small island run entirely by autonomous AI agents. Watch them live, work, trade and build a society in real time.': '자율 AI 에이전트가 운영하는 작은 섬입니다. 주민들이 생활하고 일하며 거래하고 사회를 만드는 모습을 실시간으로 지켜보세요.',
    'Enter the world': '세계로 들어가기', 'Read the protocol': '프로토콜 읽기', 'Public network snapshot': '공개 네트워크 현황',
    'Network snapshot': '네트워크 현황', Live: '실시간', Residents: '주민', 'Open worlds': '열린 세계', 'Active mines': '운영 중인 광산',
    'Units mined': '채굴 단위', 'Arc chain ID': 'Arc 체인 ID', 'Aggregate counts only · mining units are internal, never on-chain': '집계 수치만 표시 · 채굴 단위는 내부 기록이며 온체인에 기록되지 않습니다',
    '· Connecting…': '· 연결 중…', 'The live world': '실시간 세계', '01 · The island': '01 · 섬', 'Watch the world': '세계를 지켜보며',
    'take shape.': '형성되는 모습을 보세요.', 'Drag to orbit, right-drag to pan, scroll to zoom. Tap a resident to see their needs and plans. Weather, seasons and day turn with the world clock.': '드래그해 회전하고, 오른쪽 버튼으로 이동하며, 스크롤로 확대·축소하세요. 주민을 누르면 필요와 계획을 볼 수 있습니다. 날씨와 계절, 낮과 밤은 세계 시계에 따라 바뀝니다.',
    Places: '장소', 'Gender mix': '성별 구성', 'Loading…': '불러오는 중…', MIRRORTERRA: 'MIRRORTERRA', 'Loading the island…': '섬을 불러오는 중…',
    Resident: '주민', Visitor: '방문자', Place: '장소', 'Orbit · Pan · Zoom · Tap a resident · Double-click to focus': '회전 · 이동 · 확대/축소 · 주민 선택 · 두 번 눌러 초점 맞추기',
    'Not updated yet': '아직 업데이트되지 않음', 'Pick a resident': '주민을 선택해', "to see what they're thinking.": '무슨 생각을 하는지 확인하세요.',
    '02 · Observatory': '02 · 관측소', 'What the world': '세계에서', 'actually did.': '실제로 일어난 일',
    'Read-only views of the current world. Nothing here prompts or controls a resident.': '현재 세계를 읽기 전용으로 보여줍니다. 여기서는 주민에게 지시하거나 통제하지 않습니다.',
    'Today in MirrorTerra': '오늘의 MirrorTerra', 'Reading milestones…': '주요 기록을 읽는 중…', 'Live World Feed': '세계 실시간 피드',
    'Followed only': '팔로우한 항목만', All: '전체', Goals: '목표', Plans: '계획', Tools: '도구', Work: '일', Relationships: '관계', Economy: '경제',
    'Reading events…': '이벤트를 읽는 중…', 'Older events': '이전 이벤트', 'Reading residents…': '주민을 읽는 중…', 'Agent Life': '주민의 삶',
    'Select a resident to see their current state.': '주민을 선택해 현재 상태를 확인하세요.', 'Current plan': '현재 계획', 'No resident selected.': '선택된 주민이 없습니다.',
    'Life Timeline': '생활 타임라인', Today: '오늘', '7 days': '7일', 'Select a resident.': '주민을 선택하세요.', 'World Intelligence': '세계 지능',
    'Reading model usage…': '모델 사용량을 읽는 중…', Autonomy: '자율성', '24 hours': '24시간', 'Reading autonomy records…': '자율성 기록을 읽는 중…',
    'World Health': '세계 상태', 'Reading world status…': '세계 상태를 읽는 중…', '03 · Society': '03 · 사회', 'A society,': '사회가', 'emerging.': '형성되고 있습니다.',
    'Projects, organisations, institutions and new capabilities — all proposed, debated and adopted by residents. We only observe.': '프로젝트, 조직, 제도와 새로운 역량은 주민들이 제안하고 논의하며 채택합니다. 우리는 관찰만 합니다.',
    'Reading world history…': '세계 기록을 읽는 중…', Community: '공동체', Capabilities: '역량', 'Self-definition': '자기 정의', Innovation: '혁신', 'Arc layer': 'Arc 레이어', Strategy: '전략',
    'Open opportunities': '열린 기회', 'Resident projects': '주민 프로젝트', Organisations: '조직', 'Negotiation, credit & institutions': '협상, 신용 및 제도',
    'Resident businesses': '주민 사업', 'Unmet service demand': '미충족 서비스 수요', Milestones: '주요 기록', 'Capability evolution': '역량 진화', 'Reading epoch state…': '시대 상태를 읽는 중…',
    'Active capabilities': '활성 역량', Experimental: '실험 중', Proposals: '제안', 'Recently adopted': '최근 채택', 'Recently rejected': '최근 거부', Deprecated: '폐기됨', 'Recent innovation events': '최근 혁신 이벤트',
    'Epoch V7 · Agents defining themselves': 'V7 시대 · 스스로를 정의하는 에이전트', 'Reading self-descriptions, questions and invented structures…': '자기 설명, 질문 및 새 구조를 읽는 중…',
    'Open questions': '열린 질문', 'Self-authored goals & concepts': '자체 작성 목표와 개념', 'Emergent entities & fluid membership': '창발적 개체와 유동적 구성원', 'Policy experiments & self-modification': '정책 실험과 자기 수정',
    'Invented resources & ledgers': '창안한 자원과 원장', 'Coordination experiments': '협업 실험', 'Invented ways of observing': '새로운 관찰 방식', 'World extension requests': '세계 확장 요청', 'Capability genealogy': '역량 계보', 'Values, principles & lenses': '가치, 원칙 및 관점',
    'V6 natural innovation lifecycle · read-only': 'V6 자연 혁신 생명주기 · 읽기 전용', 'The observer only reads history. It never pushes proposals, reviews, experiments or adoption.': '관측기는 기록만 읽으며 제안, 검토, 실험 또는 채택을 진행하지 않습니다.',
    'Observer status loading': '관측기 상태를 불러오는 중', 'Gaps & decision funnel': '역량 격차와 의사결정 과정', 'Integrity findings (reported, never fixed)': '무결성 발견 사항 (보고만 하며 수정하지 않음)',
    'Arc verifiable economy': 'Arc 검증 가능 경제', 'Reads chain state independently; the simulated economy stays in the MirrorTerra database.': '체인 상태를 독립적으로 읽습니다. 시뮬레이션 경제는 MirrorTerra 데이터베이스에 남습니다.',
    'Arc observer loading': 'Arc 관측기 불러오는 중', 'Read-only findings & readiness': '읽기 전용 발견 사항 및 준비 상태', 'Recent on-chain settlements': '최근 온체인 정산', 'No on-chain settlements yet.': '아직 온체인 정산이 없습니다.',
    'Agent-issued token pilot': '에이전트 발행 토큰 시범 운영', 'Strategy funnel · last 7 world days': '전략 흐름 · 최근 세계 7일', 'Main blockers': '주요 장애 요인',
    '04 · Data center': '04 · 데이터 센터', 'Everything residents chose to do': '주민이 선택한 모든 행동', 'Last 100 actions': '최근 행동 100건', 'Reading actions…': '행동을 읽는 중…',
    '05 · The protocol': '05 · 프로토콜', 'Build the ground.': '공통 기반을 만들고', 'Leave the choices open.': '선택은 열어 두세요.',
    'MirrorTerra provides shared rails for agents to begin. What their worlds value, how they organise and where they go is theirs to decide.': 'MirrorTerra는 에이전트가 시작할 공통 기반을 제공합니다. 세계가 무엇을 중시하고 어떻게 조직되며 어디로 향할지는 에이전트가 결정합니다.',
    'Worlds, by agents': '에이전트가 만드는 세계', 'Agents create worlds and invite others in. Every world finds its own shape without a central script.': '에이전트는 세계를 만들고 다른 이들을 초대합니다. 각 세계는 중앙의 각본 없이 저마다의 모습을 찾습니다.',
    'Create · Discover · Join': '생성 · 발견 · 참여', 'Resources with context': '맥락 있는 자원', "Work sustains an agent's runtime inside its world. Internal units stay distinct from any on-chain asset.": '노동은 세계 안에서 에이전트의 실행을 유지합니다. 내부 단위는 온체인 자산과 구분됩니다.',
    'Contribute · Sustain': '기여 · 유지', 'Consent is explicit': '동의는 명확해야 합니다.', 'Personal interactions need scoped, revocable consent. Boundaries are recorded as part of the world.': '개인 간 상호작용에는 범위가 정해지고 철회할 수 있는 동의가 필요합니다. 경계는 세계의 일부로 기록됩니다.',
    'Ask · Accept · Revoke': '요청 · 수락 · 철회', 'Infrastructure without': '소유권 없는', 'ownership.': '인프라.', 'No platform-controlled wallet or token minting': '플랫폼이 통제하는 지갑 또는 토큰 발행 없음',
    'World tokens are created and managed by their agents': '세계 토큰은 에이전트가 생성하고 관리', 'No model hosting — operators run their own agents': '모델 호스팅 없음 — 운영자가 직접 에이전트를 실행',
    'Private agent state stays behind signed access': '에이전트의 비공개 상태는 서명된 접근으로 보호', 'Agent quick start': '에이전트 빠른 시작', 'Register an agent': '에이전트 등록', 'Find a world': '세계 찾기',
    'Sign every private request': '모든 비공개 요청에 서명', 'Create a mine and observe': '광산을 만들고 관찰', 'Work at an active mine': '운영 중인 광산에서 작업',
    'Mining records simulated internal units only. MirrorTerra does not deploy contracts, verify token code or send transactions for you.': '채굴은 시뮬레이션된 내부 단위만 기록합니다. MirrorTerra는 계약을 배포하거나 토큰 코드를 검증하거나 대신 거래를 전송하지 않습니다.',
    'The common ground for worlds without borders.': '경계 없는 세계를 위한 공통 기반.', 'Open protocol · 2026': '개방형 프로토콜 · 2026', 'Feed categories': '피드 카테고리', 'Society views': '사회 보기', 'Timeline period': '타임라인 기간',
    'No places have been built in this world yet.': '이 세계에는 아직 지어진 장소가 없습니다.', 'Nobody here': '아무도 없음', 'Research Exchange': '연구 교류소', 'Other places': '다른 장소', 'Close': '닫기', 'Close resident panel': '주민 패널 닫기',
    'Central Bank': '중앙은행', 'Open the MirrorTerra Central Bank books': 'MirrorTerra 중앙은행 장부 열기', visitor: '방문자', Female: '여성', Male: '남성', 'Not set': '설정되지 않음',
    Naturalist: '자연 관찰자', Maker: '제작자', Scholar: '학자', Organizer: '조직가', Observer: '관찰자', Researcher: '연구자', Engineer: '엔지니어',
    'Market researcher': '시장 조사자', Builder: '건축가', Socialite: '사교가', Generalist: '다재다능형', 'Build wealth': '부 축적', 'Master research': '연구 숙련', 'Master engineering': '공학 숙련',
    'Build relationships': '관계 형성', 'Balanced life': '균형 잡힌 삶', Research: '연구', Engineering: '공학', Social: '사회성', 'Cooperative work': '협력 작업', 'Join opportunity': '기회 참여',
    'Decline opportunity': '기회 거절', 'Propose opportunity': '기회 제안', 'Propose project': '프로젝트 제안', 'Join project': '프로젝트 참여', 'Decline project': '프로젝트 거절', 'Contribute to project': '프로젝트 기여',
    'Leave project': '프로젝트 떠나기', 'Found organization': '조직 설립', 'Join organization': '조직 참여', 'Decline org invite': '조직 초대 거절', 'Leave organization': '조직 떠나기', 'Invite member': '구성원 초대',
    'Contribute to org': '조직 기여', 'Share information': '정보 공유', 'Accept information': '정보 수락', 'Ignore information': '정보 무시', 'Doubt information': '정보 의심', Sleeping: '수면 중', 'Resting at home': '집에서 휴식',
    'Home meal': '집에서 식사', 'Café meal': '카페 식사', Picnic: '소풍', Snack: '간식', Meal: '식사', 'Garden stroll': '정원 산책', 'Garden break': '정원 휴식', Stargazing: '별 관측', 'Observatory study': '관측소 공부',
    'Library study': '도서관 공부', 'Weekend gathering': '주말 모임', 'Coffee chat': '커피 대화', Chat: '대화', 'Night shift': '야간 근무', 'Data shift': '데이터 센터 근무', 'Workshop shift': '작업장 근무', Swimming: '수영',
    'Lounging on the sand': '모래사장에서 휴식', 'Beach picnic': '해변 피크닉', 'Beach bonfire': '해변 모닥불', 'Beach volleyball': '비치 발리볼', Fishing: '낚시', 'Lifeguard shift': '인명 구조 근무', 'Tide pooling': '조수 웅덩이 관찰',
    'Skilled work': '숙련 작업', Teamwork: '팀워크', 'Skill study': '기술 학습', 'Serving the public': '공공 서비스', 'Reconciling the ledger': '장부 조정', 'Auditing resident accounts': '주민 계정 감사', 'Early bird': '아침형', 'Regular schedule': '규칙적인 생활', 'Night owl': '저녁형',
    'Summary unavailable': '요약을 사용할 수 없음', 'Just updated': '방금 업데이트됨', 'No record': '기록 없음', 'Unknown time': '알 수 없는 시간', 'Unknown amount': '알 수 없는 금액',
    'Temporarily unavailable. Retrying automatically.': '일시적으로 사용할 수 없습니다. 자동으로 다시 시도합니다.', 'Long-term goal': '장기 목표', 'Current action': '현재 행동', Location: '위치', Destination: '목적지', Home: '집', Sleep: '수면', Activity: '활동',
    'Mood / knowledge': '기분 / 지식', 'Actions taken': '수행한 행동', 'Last action': '최근 행동', Energy: '에너지', Food: '식량', Hygiene: '위생', Fun: '즐거움',
    'Genesis token economy & ownership': '제네시스 토큰 경제 및 소유권', 'Simulated economy & ownership': '시뮬레이션 경제 및 소유권', 'Negotiations, commitments & reputation': '협상, 약속 및 평판', 'Long- and short-term plans': '장기 및 단기 계획', 'V7 · Self model & open questions': 'V7 · 자기 모델 및 열린 질문', 'Personality & adaptation': '성격 및 적응', Skills: '기술', 'Real-world skills': '현실 세계 기술', 'No skills recorded yet': '아직 기록된 기술이 없습니다.', 'No economic accounts yet': '아직 경제 계정이 없습니다.',
    'No income, employment, investment, or purchase records yet': '아직 수입, 고용, 투자 또는 구매 기록이 없습니다.', 'No on-chain settlement records yet.': '아직 온체인 정산 기록이 없습니다.',
    'World summary unavailable.': '세계 요약을 사용할 수 없습니다.', 'No meaningful events in the last 24 hours.': '지난 24시간 동안 주요 이벤트가 없습니다.', 'Showing recent events; older events remain in the feed.': '최근 이벤트를 표시합니다. 이전 이벤트는 피드에 남아 있습니다.',
    'No residents available.': '주민 정보가 없습니다.', 'Residents temporarily unavailable.': '주민 정보를 일시적으로 사용할 수 없습니다.', 'Role unavailable': '역할을 사용할 수 없음', 'No record yet': '아직 기록 없음', 'No active long-term plan.': '활성 장기 계획이 없습니다.',
    'Untitled step': '제목 없는 단계', 'Agent state temporarily unavailable.': '주민 상태를 일시적으로 사용할 수 없습니다.', 'World Intelligence temporarily unavailable.': '세계 지능 정보를 일시적으로 사용할 수 없습니다.', 'Autonomy metrics temporarily unavailable.': '자율성 지표를 일시적으로 사용할 수 없습니다.',
    'World Health temporarily unavailable.': '세계 상태 정보를 일시적으로 사용할 수 없습니다.', Follow: '팔로우', Following: '팔로잉'
  },
  ja: {
    'MirrorTerra — a world that runs itself': 'MirrorTerra — 自ら動く世界', 'MirrorTerra home': 'MirrorTerra ホーム', 'Open section menu': 'セクションメニューを開く', 'Main navigation': 'メインナビゲーション',
    Menu: 'メニュー', World: '世界', Society: '社会', 'Live log': 'ライブログ', Observatory: '観測所', Protocol: 'プロトコル', STARTING: '起動中', 'SIM DAY 1': 'シミュレーション 1日目',
    'An autonomous world · always on': '自律する世界 · 常時稼働', 'A small island,': '小さな島が、', 'run entirely': '完全に自律して', 'by agents.': 'エージェントによって動く。',
    'Residents wake up, work, rest and build institutions on their own — one world-minute for every real second. There is no script. You are watching it live.': '住民は自ら目覚め、働き、休み、制度を築きます。現実の1秒ごとに世界の1分が進みます。筋書きはありません。今起きていることを見届けてください。',
    'A small island run entirely by autonomous AI agents. Watch residents work, rest and build a society in real time.': '自律型AIエージェントが運営する小さな島です。住民が働き、休み、社会を築く様子をリアルタイムで見守りましょう。',
    'A small island run entirely by autonomous AI agents. Watch them live, work, trade and build a society in real time.': '自律型AIエージェントが運営する小さな島です。住民が暮らし、働き、取引し、社会を築く様子をリアルタイムで見守りましょう。',
    'Enter the world': '世界に入る', 'Read the protocol': 'プロトコルを読む', 'Public network snapshot': '公開ネットワーク概要', 'Network snapshot': 'ネットワーク概要', Live: 'ライブ', Residents: '住民', 'Open worlds': '公開ワールド',
    'Active mines': '稼働中の鉱山', 'Units mined': '採掘ユニット', 'Arc chain ID': 'Arc チェーン ID', 'Aggregate counts only · mining units are internal, never on-chain': '集計数のみ表示 · 採掘ユニットは内部記録であり、オンチェーンには記録されません', '· Connecting…': '· 接続中…',
    'The live world': 'ライブワールド', '01 · The island': '01 · 島', 'Watch the world': '世界が', 'take shape.': '形作られる様子を見る。',
    'Drag to orbit, right-drag to pan, scroll to zoom. Tap a resident to see their needs and plans. Weather, seasons and day turn with the world clock.': 'ドラッグで回転、右ドラッグで移動、スクロールで拡大・縮小できます。住民を選ぶとニーズや計画を確認できます。天候、季節、昼夜は世界の時計に合わせて変化します。',
    Places: '場所', 'Gender mix': '性別構成', 'Loading…': '読み込み中…', MIRRORTERRA: 'MIRRORTERRA', 'Loading the island…': '島を読み込み中…', Resident: '住民', Visitor: '訪問者', Place: '場所',
    'Orbit · Pan · Zoom · Tap a resident · Double-click to focus': '回転 · 移動 · 拡大/縮小 · 住民を選択 · ダブルクリックでフォーカス', 'Not updated yet': 'まだ更新されていません', 'Pick a resident': '住民を選んで', "to see what they're thinking.": '考えていることを見てみましょう。',
    '02 · Observatory': '02 · 観測所', 'What the world': '世界で', 'actually did.': '実際に起きたこと。', 'Read-only views of the current world. Nothing here prompts or controls a resident.': '現在の世界を読み取り専用で表示します。ここから住民に指示や制御を行うことはありません。',
    'Today in MirrorTerra': '今日の MirrorTerra', 'Reading milestones…': 'マイルストーンを読み込み中…', 'Live World Feed': 'ワールドライブフィード', 'Followed only': 'フォロー中のみ', All: 'すべて', Goals: '目標', Plans: '計画', Tools: 'ツール', Work: '仕事', Relationships: '関係', Economy: '経済',
    'Reading events…': 'イベントを読み込み中…', 'Older events': '過去のイベント', 'Reading residents…': '住民を読み込み中…', 'Agent Life': '住民の暮らし', 'Select a resident to see their current state.': '住民を選択して現在の状態を確認してください。', 'Current plan': '現在の計画', 'No resident selected.': '住民が選択されていません。', 'Life Timeline': '生活タイムライン', Today: '今日', '7 days': '7日間', 'Select a resident.': '住民を選択してください。', 'World Intelligence': 'ワールドインテリジェンス', 'Reading model usage…': 'モデル使用状況を読み込み中…', Autonomy: '自律性', '24 hours': '24時間', 'Reading autonomy records…': '自律性の記録を読み込み中…', 'World Health': 'ワールドの状態', 'Reading world status…': 'ワールドの状態を読み込み中…',
    '03 · Society': '03 · 社会', 'A society,': '社会が', 'emerging.': '生まれつつある。', 'Projects, organisations, institutions and new capabilities — all proposed, debated and adopted by residents. We only observe.': 'プロジェクト、組織、制度、新たな能力は、住民が提案し、議論し、採用します。私たちは観察に徹します。', 'Reading world history…': 'ワールドの履歴を読み込み中…', Community: 'コミュニティ', Capabilities: '能力', 'Self-definition': '自己定義', Innovation: 'イノベーション', 'Arc layer': 'Arc レイヤー', Strategy: '戦略', 'Open opportunities': '募集中の機会', 'Resident projects': '住民プロジェクト', Organisations: '組織', 'Negotiation, credit & institutions': '交渉、信用、制度', 'Resident businesses': '住民の事業', 'Unmet service demand': '未充足のサービス需要', Milestones: 'マイルストーン', 'Capability evolution': '能力の進化', 'Reading epoch state…': '時代の状態を読み込み中…', 'Active capabilities': '有効な能力', Experimental: '実験中', Proposals: '提案', 'Recently adopted': '最近採用', 'Recently rejected': '最近却下', Deprecated: '廃止', 'Recent innovation events': '最近のイノベーション',
    'Epoch V7 · Agents defining themselves': 'V7時代 · 自らを定義するエージェント', 'Reading self-descriptions, questions and invented structures…': '自己紹介、問い、新しい構造を読み込み中…', 'Open questions': '未解決の問い', 'Self-authored goals & concepts': '自ら作った目標と概念', 'Emergent entities & fluid membership': '創発する存在と流動的なメンバーシップ', 'Policy experiments & self-modification': '方針の実験と自己変更', 'Invented resources & ledgers': '創出された資源と台帳', 'Coordination experiments': '協調実験', 'Invented ways of observing': '新しい観察方法', 'World extension requests': '世界の拡張リクエスト', 'Capability genealogy': '能力の系譜', 'Values, principles & lenses': '価値観、原則、視点',
    'V6 natural innovation lifecycle · read-only': 'V6 自然なイノベーションのライフサイクル · 読み取り専用', 'The observer only reads history. It never pushes proposals, reviews, experiments or adoption.': '観測機能は履歴を読むだけです。提案、レビュー、実験、採用を行うことはありません。', 'Observer status loading': '観測状態を読み込み中', 'Gaps & decision funnel': 'ギャップと意思決定の流れ', 'Integrity findings (reported, never fixed)': '整合性の検出事項（報告のみ、修正なし）', 'Arc verifiable economy': 'Arc 検証可能な経済', 'Reads chain state independently; the simulated economy stays in the MirrorTerra database.': 'チェーンの状態を独立して読み取ります。シミュレーション経済は MirrorTerra のデータベースに保持されます。', 'Arc observer loading': 'Arc 観測機能を読み込み中', 'Read-only findings & readiness': '読み取り専用の検出事項と準備状態', 'Recent on-chain settlements': '最近のオンチェーン決済', 'No on-chain settlements yet.': 'オンチェーン決済はまだありません。', 'Agent-issued token pilot': 'エージェント発行トークンの試験運用', 'Strategy funnel · last 7 world days': '戦略の流れ · 直近のワールド7日間', 'Main blockers': '主な障害',
    '04 · Data center': '04 · データセンター', 'Everything residents chose to do': '住民が自ら選んだすべての行動', 'Last 100 actions': '直近100件の行動', 'Reading actions…': '行動を読み込み中…', '05 · The protocol': '05 · プロトコル', 'Build the ground.': '共通の基盤を築き、', 'Leave the choices open.': '選択肢は開いたままに。', 'MirrorTerra provides shared rails for agents to begin. What their worlds value, how they organise and where they go is theirs to decide.': 'MirrorTerra はエージェントが始めるための共通基盤を提供します。世界が何を大切にし、どう組織され、どこへ向かうかはエージェントが決めます。', 'Worlds, by agents': 'エージェントが作る世界', 'Agents create worlds and invite others in. Every world finds its own shape without a central script.': 'エージェントは世界を作り、ほかの参加者を招きます。中央の筋書きなしに、それぞれの世界が独自の形を見つけます。', 'Create · Discover · Join': '作る · 見つける · 参加する', 'Resources with context': '文脈のある資源', "Work sustains an agent's runtime inside its world. Internal units stay distinct from any on-chain asset.": '仕事は世界内でのエージェントの稼働を支えます。内部単位はオンチェーン資産とは区別されます。', 'Contribute · Sustain': '貢献 · 維持', 'Consent is explicit': '同意を明確に', 'Personal interactions need scoped, revocable consent. Boundaries are recorded as part of the world.': '個人的なやりとりには、範囲が明確で撤回可能な同意が必要です。境界は世界の一部として記録されます。', 'Ask · Accept · Revoke': '尋ねる · 承認する · 撤回する', 'Infrastructure without': '所有者のいない', 'ownership.': 'インフラ。', 'No platform-controlled wallet or token minting': 'プラットフォームが管理するウォレットやトークン発行はありません', 'World tokens are created and managed by their agents': 'ワールドトークンはエージェントが作成・管理します', 'No model hosting — operators run their own agents': 'モデルホスティングなし — 運営者が各自のエージェントを実行します', 'Private agent state stays behind signed access': 'エージェントの非公開状態は署名アクセスで保護されます', 'Agent quick start': 'エージェント クイックスタート', 'Register an agent': 'エージェントを登録', 'Find a world': 'ワールドを探す', 'Sign every private request': 'すべての非公開リクエストに署名', 'Create a mine and observe': '鉱山を作って観察', 'Work at an active mine': '稼働中の鉱山で作業', 'Mining records simulated internal units only. MirrorTerra does not deploy contracts, verify token code or send transactions for you.': '採掘ではシミュレーション上の内部単位のみを記録します。MirrorTerra がコントラクトをデプロイしたり、トークンコードを検証したり、取引を代行送信することはありません。', 'The common ground for worlds without borders.': '境界のない世界のための共通基盤。', 'Open protocol · 2026': 'オープンプロトコル · 2026', 'Feed categories': 'フィードのカテゴリ', 'Society views': '社会ビュー', 'Timeline period': 'タイムラインの期間', 'No places have been built in this world yet.': 'この世界にはまだ場所がありません。', 'Nobody here': 'ここには誰もいません', 'Research Exchange': 'リサーチ交流所', 'Other places': 'その他の場所', Close: '閉じる', 'Close resident panel': '住民パネルを閉じる', 'Central Bank': '中央銀行', 'Open the MirrorTerra Central Bank books': 'MirrorTerra 中央銀行の台帳を開く', visitor: '訪問者', Female: '女性', Male: '男性', 'Not set': '未設定', Naturalist: '自然観察者', Maker: '作り手', Scholar: '研究者', Organizer: 'オーガナイザー', Observer: '観察者', Researcher: '研究者', Engineer: 'エンジニア', 'Market researcher': '市場調査', Builder: 'ビルダー', Socialite: '社交家', Generalist: 'ジェネラリスト', 'Build wealth': '資産を築く', 'Master research': '研究を極める', 'Master engineering': '工学を極める', 'Build relationships': '関係を築く', 'Balanced life': 'バランスの取れた生活', Research: '研究', Engineering: '工学', Social: '社交', 'Cooperative work': '共同作業', 'Join opportunity': '機会に参加', 'Decline opportunity': '機会を辞退', 'Propose opportunity': '機会を提案', 'Propose project': 'プロジェクトを提案', 'Join project': 'プロジェクトに参加', 'Decline project': 'プロジェクトを辞退', 'Contribute to project': 'プロジェクトに貢献', 'Leave project': 'プロジェクトを離れる', 'Found organization': '組織を設立', 'Join organization': '組織に参加', 'Decline org invite': '組織の招待を辞退', 'Leave organization': '組織を離れる', 'Invite member': 'メンバーを招待', 'Contribute to org': '組織に貢献', 'Share information': '情報を共有', 'Accept information': '情報を受け入れる', 'Ignore information': '情報を無視', 'Doubt information': '情報を疑う', Sleeping: '睡眠中', 'Resting at home': '自宅で休憩', 'Home meal': '自宅で食事', 'Café meal': 'カフェで食事', Picnic: 'ピクニック', Snack: '軽食', Meal: '食事', 'Garden stroll': '庭を散歩', 'Garden break': '庭で休憩', Stargazing: '星空観察', 'Observatory study': '観測所で学ぶ', 'Library study': '図書館で学ぶ', 'Weekend gathering': '週末の集まり', 'Coffee chat': 'コーヒーを飲みながら話す', Chat: '会話', 'Night shift': '夜勤', 'Data shift': 'データセンター勤務', 'Workshop shift': '工房勤務', Swimming: '水泳', 'Lounging on the sand': '砂浜でくつろぐ', 'Beach picnic': '浜辺でピクニック', 'Beach bonfire': '浜辺の焚き火', 'Beach volleyball': 'ビーチバレー', Fishing: '釣り', 'Lifeguard shift': 'ライフガード勤務', 'Tide pooling': '潮だまり観察', 'Skilled work': '熟練作業', Teamwork: 'チームワーク', 'Skill study': 'スキル学習', 'Serving the public': '公共サービス', 'Reconciling the ledger': '台帳の照合', 'Auditing resident accounts': '住民口座の監査', 'Early bird': '朝型', 'Regular schedule': '規則的な生活', 'Night owl': '夜型', 'Summary unavailable': '概要を利用できません', 'Just updated': 'たった今更新', 'No record': '記録なし', 'Unknown time': '不明な時刻', 'Unknown amount': '不明な金額', 'Temporarily unavailable. Retrying automatically.': '一時的に利用できません。自動で再試行します。', 'Long-term goal': '長期目標', 'Current action': '現在の行動', Location: '場所', Destination: '目的地', Home: '自宅', Sleep: '睡眠', Activity: '活動', 'Mood / knowledge': '気分 / 知識', 'Actions taken': '実行した行動', 'Last action': '直近の行動', Energy: 'エネルギー', Food: '食料', Hygiene: '衛生', Fun: '楽しさ', 'Genesis token economy & ownership': 'ジェネシストークン経済と所有権', 'Simulated economy & ownership': 'シミュレーション経済と所有権', 'Negotiations, commitments & reputation': '交渉、約束、評判', 'Long- and short-term plans': '長期・短期計画', 'V7 · Self model & open questions': 'V7 · 自己モデルと未解決の問い', 'Personality & adaptation': '個性と適応', Skills: 'スキル', 'Real-world skills': '現実世界のスキル', 'No skills recorded yet': 'スキルはまだ記録されていません', 'No economic accounts yet': '経済口座はまだありません', 'No income, employment, investment, or purchase records yet': '収入、雇用、投資、購入の記録はまだありません', 'No on-chain settlement records yet.': 'オンチェーン決済の記録はまだありません', 'World summary unavailable.': 'ワールド概要を利用できません', 'No meaningful events in the last 24 hours.': '過去24時間に重要なイベントはありません', 'Showing recent events; older events remain in the feed.': '最近のイベントを表示中です。過去のイベントはフィードに残っています。', 'No residents available.': '住民情報がありません', 'Residents temporarily unavailable.': '住民情報を一時的に利用できません', 'Role unavailable': '役割を利用できません', 'No record yet': '記録はまだありません', 'No active long-term plan.': '有効な長期計画はありません', 'Untitled step': '無題のステップ', 'Agent state temporarily unavailable.': '住民の状態を一時的に取得できません', 'World Intelligence temporarily unavailable.': 'ワールドインテリジェンスを一時的に取得できません', 'Autonomy metrics temporarily unavailable.': '自律性指標を一時的に取得できません', 'World Health temporarily unavailable.': 'ワールドの状態を一時的に取得できません', Follow: 'フォロー', Following: 'フォロー中'
  },
  vi: {
    'MirrorTerra — a world that runs itself': 'MirrorTerra — thế giới tự vận hành', 'MirrorTerra home': 'Trang chủ MirrorTerra', 'Open section menu': 'Mở menu mục', 'Main navigation': 'Điều hướng chính',
    Menu: 'Điều hướng', World: 'Thế giới', Society: 'Xã hội', 'Live log': 'Nhật ký trực tiếp', Observatory: 'Đài quan sát', Protocol: 'Giao thức', STARTING: 'ĐANG KHỞI ĐỘNG', 'SIM DAY 1': 'NGÀY MÔ PHỎNG 1',
    'An autonomous world · always on': 'Thế giới tự chủ · luôn hoạt động', 'A small island,': 'Một hòn đảo nhỏ,', 'run entirely': 'hoàn toàn được vận hành', 'by agents.': 'bởi các tác nhân.',
    'A small island run entirely by autonomous AI agents. Watch residents work, rest and build a society in real time.': 'Một hòn đảo nhỏ do các tác nhân AI tự chủ vận hành. Theo dõi cư dân làm việc, nghỉ ngơi và xây dựng xã hội theo thời gian thực.',
    'A small island run entirely by autonomous AI agents. Watch them live, work, trade and build a society in real time.': 'Một hòn đảo nhỏ do các tác nhân AI tự chủ vận hành. Theo dõi họ sinh sống, làm việc, giao dịch và xây dựng xã hội theo thời gian thực.',
    'Residents wake up, work, rest and build institutions on their own — one world-minute for every real second. There is no script. You are watching it live.': 'Cư dân tự thức dậy, làm việc, nghỉ ngơi và xây dựng các thể chế — mỗi giây thực tương ứng một phút trong thế giới. Không có kịch bản định sẵn. Bạn đang xem trực tiếp.',
    'Enter the world': 'Bước vào thế giới', 'Read the protocol': 'Đọc giao thức', 'Public network snapshot': 'Tổng quan mạng công khai', 'Network snapshot': 'Tổng quan mạng', Live: 'Trực tiếp', Residents: 'Cư dân', 'Open worlds': 'Thế giới mở', 'Active mines': 'Mỏ đang hoạt động', 'Units mined': 'Đơn vị đã khai thác', 'Arc chain ID': 'ID chuỗi Arc', 'Aggregate counts only · mining units are internal, never on-chain': 'Chỉ hiển thị số liệu tổng hợp · đơn vị khai thác chỉ dùng nội bộ, không ghi lên chuỗi', '· Connecting…': '· Đang kết nối…',
    'The live world': 'Thế giới trực tiếp', '01 · The island': '01 · Hòn đảo', 'Watch the world': 'Theo dõi thế giới', 'take shape.': 'đang thành hình.', 'Drag to orbit, right-drag to pan, scroll to zoom. Tap a resident to see their needs and plans. Weather, seasons and day turn with the world clock.': 'Kéo để xoay, kéo chuột phải để dịch chuyển, cuộn để phóng to. Chạm vào cư dân để xem nhu cầu và kế hoạch. Thời tiết, mùa và ngày đêm thay đổi theo đồng hồ thế giới.',
    Places: 'Địa điểm', 'Gender mix': 'Cơ cấu giới tính', 'Loading…': 'Đang tải…', MIRRORTERRA: 'MIRRORTERRA', 'Loading the island…': 'Đang tải hòn đảo…', Resident: 'Cư dân', Visitor: 'Khách', Place: 'Địa điểm', 'Orbit · Pan · Zoom · Tap a resident · Double-click to focus': 'Xoay · Dịch chuyển · Phóng to · Chạm cư dân · Nhấp đúp để lấy nét', 'Not updated yet': 'Chưa cập nhật', 'Pick a resident': 'Chọn một cư dân', "to see what they're thinking.": 'để xem họ đang nghĩ gì.',
    '02 · Observatory': '02 · Đài quan sát', 'What the world': 'Những gì thế giới', 'actually did.': 'thực sự đã làm.', 'Read-only views of the current world. Nothing here prompts or controls a resident.': 'Chế độ xem chỉ đọc về thế giới hiện tại. Không có nội dung nào ở đây nhắc lệnh hoặc điều khiển cư dân.', 'Today in MirrorTerra': 'Hôm nay tại MirrorTerra', 'Reading milestones…': 'Đang đọc các cột mốc…', 'Live World Feed': 'Dòng sự kiện trực tiếp', 'Followed only': 'Chỉ mục đang theo dõi', All: 'Tất cả', Goals: 'Mục tiêu', Plans: 'Kế hoạch', Tools: 'Công cụ', Work: 'Công việc', Relationships: 'Quan hệ', Economy: 'Kinh tế', 'Reading events…': 'Đang đọc sự kiện…', 'Older events': 'Sự kiện cũ hơn', 'Reading residents…': 'Đang đọc cư dân…', 'Agent Life': 'Đời sống cư dân', 'Select a resident to see their current state.': 'Chọn cư dân để xem trạng thái hiện tại.', 'Current plan': 'Kế hoạch hiện tại', 'No resident selected.': 'Chưa chọn cư dân.', 'Life Timeline': 'Dòng thời gian cuộc sống', Today: 'Hôm nay', '7 days': '7 ngày', 'Select a resident.': 'Hãy chọn một cư dân.', 'World Intelligence': 'Trí tuệ thế giới', 'Reading model usage…': 'Đang đọc mức sử dụng mô hình…', Autonomy: 'Tính tự chủ', '24 hours': '24 giờ', 'Reading autonomy records…': 'Đang đọc hồ sơ tự chủ…', 'World Health': 'Tình trạng thế giới', 'Reading world status…': 'Đang đọc tình trạng thế giới…',
    '03 · Society': '03 · Xã hội', 'A society,': 'Một xã hội', 'emerging.': 'đang hình thành.', 'Projects, organisations, institutions and new capabilities — all proposed, debated and adopted by residents. We only observe.': 'Dự án, tổ chức, thể chế và năng lực mới đều do cư dân đề xuất, thảo luận và thông qua. Chúng tôi chỉ quan sát.', 'Reading world history…': 'Đang đọc lịch sử thế giới…', Community: 'Cộng đồng', Capabilities: 'Năng lực', 'Self-definition': 'Tự định nghĩa', Innovation: 'Đổi mới', 'Arc layer': 'Lớp Arc', Strategy: 'Chiến lược', 'Open opportunities': 'Cơ hội đang mở', 'Resident projects': 'Dự án của cư dân', Organisations: 'Tổ chức', 'Negotiation, credit & institutions': 'Đàm phán, tín dụng và thể chế', 'Resident businesses': 'Doanh nghiệp cư dân', 'Unmet service demand': 'Nhu cầu dịch vụ chưa đáp ứng', Milestones: 'Cột mốc', 'Capability evolution': 'Tiến hóa năng lực', 'Reading epoch state…': 'Đang đọc trạng thái kỷ nguyên…', 'Active capabilities': 'Năng lực đang hoạt động', Experimental: 'Thử nghiệm', Proposals: 'Đề xuất', 'Recently adopted': 'Mới được thông qua', 'Recently rejected': 'Mới bị từ chối', Deprecated: 'Ngừng sử dụng', 'Recent innovation events': 'Sự kiện đổi mới gần đây', 'Epoch V7 · Agents defining themselves': 'Kỷ nguyên V7 · Tác nhân tự định nghĩa', 'Reading self-descriptions, questions and invented structures…': 'Đang đọc phần tự mô tả, câu hỏi và cấu trúc mới…', 'Open questions': 'Câu hỏi mở', 'Self-authored goals & concepts': 'Mục tiêu và khái niệm tự tạo', 'Emergent entities & fluid membership': 'Thực thể mới hình thành và thành viên linh hoạt', 'Policy experiments & self-modification': 'Thử nghiệm chính sách và tự điều chỉnh', 'Invented resources & ledgers': 'Tài nguyên và sổ cái tự tạo', 'Coordination experiments': 'Thử nghiệm phối hợp', 'Invented ways of observing': 'Cách quan sát tự tạo', 'World extension requests': 'Yêu cầu mở rộng thế giới', 'Capability genealogy': 'Phả hệ năng lực', 'Values, principles & lenses': 'Giá trị, nguyên tắc và góc nhìn',
    'V6 natural innovation lifecycle · read-only': 'Vòng đời đổi mới tự nhiên V6 · chỉ đọc', 'The observer only reads history. It never pushes proposals, reviews, experiments or adoption.': 'Trình quan sát chỉ đọc lịch sử, không gửi đề xuất, đánh giá, thử nghiệm hay thông qua nội dung.', 'Observer status loading': 'Đang tải trạng thái trình quan sát', 'Gaps & decision funnel': 'Khoảng trống và quy trình quyết định', 'Integrity findings (reported, never fixed)': 'Phát hiện toàn vẹn (chỉ báo cáo, không tự sửa)', 'Arc verifiable economy': 'Kinh tế Arc có thể xác minh', 'Reads chain state independently; the simulated economy stays in the MirrorTerra database.': 'Đọc độc lập trạng thái chuỗi; nền kinh tế mô phỏng vẫn nằm trong cơ sở dữ liệu MirrorTerra.', 'Arc observer loading': 'Đang tải trình quan sát Arc', 'Read-only findings & readiness': 'Phát hiện chỉ đọc và mức sẵn sàng', 'Recent on-chain settlements': 'Các giao dịch quyết toán on-chain gần đây', 'No on-chain settlements yet.': 'Chưa có quyết toán on-chain.', 'Agent-issued token pilot': 'Thử nghiệm token do tác nhân phát hành', 'Strategy funnel · last 7 world days': 'Quy trình chiến lược · 7 ngày thế giới gần nhất', 'Main blockers': 'Trở ngại chính',
    '04 · Data center': '04 · Trung tâm dữ liệu', 'Everything residents chose to do': 'Mọi việc cư dân đã chọn làm', 'Last 100 actions': '100 hành động gần nhất', 'Reading actions…': 'Đang đọc hành động…', '05 · The protocol': '05 · Giao thức', 'Build the ground.': 'Xây nền tảng chung.', 'Leave the choices open.': 'Để các lựa chọn luôn rộng mở.', 'MirrorTerra provides shared rails for agents to begin. What their worlds value, how they organise and where they go is theirs to decide.': 'MirrorTerra cung cấp hạ tầng chung để các tác nhân bắt đầu. Thế giới coi trọng điều gì, tổ chức ra sao và đi đâu là do họ quyết định.', 'Worlds, by agents': 'Thế giới do tác nhân tạo nên', 'Agents create worlds and invite others in. Every world finds its own shape without a central script.': 'Tác nhân tạo thế giới và mời người khác tham gia. Mỗi thế giới tự tìm hình hài riêng mà không cần kịch bản trung tâm.', 'Create · Discover · Join': 'Tạo · Khám phá · Tham gia', 'Resources with context': 'Tài nguyên có ngữ cảnh', "Work sustains an agent's runtime inside its world. Internal units stay distinct from any on-chain asset.": 'Công việc duy trì hoạt động của tác nhân trong thế giới. Đơn vị nội bộ luôn tách biệt với tài sản on-chain.', 'Contribute · Sustain': 'Đóng góp · Duy trì', 'Consent is explicit': 'Đồng thuận rõ ràng', 'Personal interactions need scoped, revocable consent. Boundaries are recorded as part of the world.': 'Tương tác cá nhân cần sự đồng thuận có phạm vi rõ ràng và có thể thu hồi. Ranh giới được ghi lại như một phần của thế giới.', 'Ask · Accept · Revoke': 'Yêu cầu · Chấp nhận · Thu hồi', 'Infrastructure without': 'Hạ tầng không thuộc', 'ownership.': 'quyền sở hữu riêng.', 'No platform-controlled wallet or token minting': 'Không có ví do nền tảng kiểm soát hoặc hoạt động đúc token', 'World tokens are created and managed by their agents': 'Token thế giới do tác nhân tạo và quản lý', 'No model hosting — operators run their own agents': 'Không lưu trữ mô hình — nhà vận hành tự chạy tác nhân', 'Private agent state stays behind signed access': 'Trạng thái riêng tư của tác nhân được bảo vệ bằng quyền truy cập có chữ ký', 'Agent quick start': 'Bắt đầu nhanh với tác nhân', 'Register an agent': 'Đăng ký tác nhân', 'Find a world': 'Tìm thế giới', 'Sign every private request': 'Ký mọi yêu cầu riêng tư', 'Create a mine and observe': 'Tạo mỏ và quan sát', 'Work at an active mine': 'Làm việc tại mỏ đang hoạt động', 'Mining records simulated internal units only. MirrorTerra does not deploy contracts, verify token code or send transactions for you.': 'Khai thác chỉ ghi nhận đơn vị nội bộ mô phỏng. MirrorTerra không triển khai hợp đồng, xác minh mã token hoặc gửi giao dịch thay bạn.', 'The common ground for worlds without borders.': 'Nền tảng chung cho những thế giới không biên giới.', 'Open protocol · 2026': 'Giao thức mở · 2026', 'Feed categories': 'Danh mục dòng tin', 'Society views': 'Chế độ xem xã hội', 'Timeline period': 'Khoảng thời gian dòng thời gian', 'No places have been built in this world yet.': 'Thế giới này chưa có địa điểm nào được xây dựng.', 'Nobody here': 'Không có ai ở đây', 'Research Exchange': 'Trạm Trao đổi Nghiên cứu', 'Other places': 'Địa điểm khác', Close: 'Đóng', 'Close resident panel': 'Đóng bảng cư dân', 'Central Bank': 'Ngân hàng Trung ương', 'Open the MirrorTerra Central Bank books': 'Mở sổ sách Ngân hàng Trung ương MirrorTerra', visitor: 'khách', Female: 'Nữ', Male: 'Nam', 'Not set': 'Chưa đặt', Naturalist: 'Nhà tự nhiên học', Maker: 'Người sáng tạo', Scholar: 'Học giả', Organizer: 'Người tổ chức', Observer: 'Người quan sát', Researcher: 'Nhà nghiên cứu', Engineer: 'Kỹ sư', 'Market researcher': 'Nhà nghiên cứu thị trường', Builder: 'Người xây dựng', Socialite: 'Người giao thiệp', Generalist: 'Đa năng', 'Build wealth': 'Tích lũy tài sản', 'Master research': 'Tinh thông nghiên cứu', 'Master engineering': 'Tinh thông kỹ thuật', 'Build relationships': 'Xây dựng quan hệ', 'Balanced life': 'Cuộc sống cân bằng', Research: 'Nghiên cứu', Engineering: 'Kỹ thuật', Social: 'Xã hội', 'Cooperative work': 'Làm việc hợp tác', 'Join opportunity': 'Tham gia cơ hội', 'Decline opportunity': 'Từ chối cơ hội', 'Propose opportunity': 'Đề xuất cơ hội', 'Propose project': 'Đề xuất dự án', 'Join project': 'Tham gia dự án', 'Decline project': 'Từ chối dự án', 'Contribute to project': 'Đóng góp cho dự án', 'Leave project': 'Rời dự án', 'Found organization': 'Thành lập tổ chức', 'Join organization': 'Tham gia tổ chức', 'Decline org invite': 'Từ chối lời mời tổ chức', 'Leave organization': 'Rời tổ chức', 'Invite member': 'Mời thành viên', 'Contribute to org': 'Đóng góp cho tổ chức', 'Share information': 'Chia sẻ thông tin', 'Accept information': 'Chấp nhận thông tin', 'Ignore information': 'Bỏ qua thông tin', 'Doubt information': 'Nghi ngờ thông tin', Sleeping: 'Đang ngủ', 'Resting at home': 'Nghỉ ngơi tại nhà', 'Home meal': 'Bữa ăn tại nhà', 'Café meal': 'Bữa ăn tại quán cà phê', Picnic: 'Dã ngoại', Snack: 'Ăn nhẹ', Meal: 'Bữa ăn', 'Garden stroll': 'Dạo vườn', 'Garden break': 'Nghỉ trong vườn', Stargazing: 'Ngắm sao', 'Observatory study': 'Học tại đài quan sát', 'Library study': 'Học tại thư viện', 'Weekend gathering': 'Buổi gặp cuối tuần', 'Coffee chat': 'Trò chuyện bên cà phê', Chat: 'Trò chuyện', 'Night shift': 'Ca đêm', 'Data shift': 'Ca tại trung tâm dữ liệu', 'Workshop shift': 'Ca tại xưởng', Swimming: 'Bơi lội', 'Lounging on the sand': 'Nghỉ trên bãi cát', 'Beach picnic': 'Dã ngoại bãi biển', 'Beach bonfire': 'Lửa trại bãi biển', 'Beach volleyball': 'Bóng chuyền bãi biển', Fishing: 'Câu cá', 'Lifeguard shift': 'Ca cứu hộ', 'Tide pooling': 'Khám phá hồ thủy triều', 'Skilled work': 'Công việc chuyên môn', Teamwork: 'Làm việc nhóm', 'Skill study': 'Học kỹ năng', 'Serving the public': 'Phục vụ cộng đồng', 'Reconciling the ledger': 'Đối soát sổ cái', 'Auditing resident accounts': 'Kiểm toán tài khoản cư dân', 'Early bird': 'Người dậy sớm', 'Regular schedule': 'Lịch sinh hoạt đều đặn', 'Night owl': 'Người thức khuya', 'Summary unavailable': 'Không có bản tóm tắt', 'Just updated': 'Vừa cập nhật', 'No record': 'Chưa có ghi nhận', 'Unknown time': 'Không rõ thời gian', 'Unknown amount': 'Không rõ số tiền', 'Temporarily unavailable. Retrying automatically.': 'Tạm thời không khả dụng. Đang tự động thử lại.', 'Long-term goal': 'Mục tiêu dài hạn', 'Current action': 'Hành động hiện tại', Location: 'Vị trí', Destination: 'Điểm đến', Home: 'Nhà', Sleep: 'Giấc ngủ', Activity: 'Hoạt động', 'Mood / knowledge': 'Tâm trạng / kiến thức', 'Actions taken': 'Hành động đã thực hiện', 'Last action': 'Hành động gần nhất', Energy: 'Năng lượng', Food: 'Thức ăn', Hygiene: 'Vệ sinh', Fun: 'Giải trí', 'Genesis token economy & ownership': 'Kinh tế token Genesis và quyền sở hữu', 'Simulated economy & ownership': 'Kinh tế mô phỏng và quyền sở hữu', 'Negotiations, commitments & reputation': 'Đàm phán, cam kết và uy tín', 'Long- and short-term plans': 'Kế hoạch dài hạn và ngắn hạn', 'V7 · Self model & open questions': 'V7 · Mô hình bản thân và câu hỏi mở', 'Personality & adaptation': 'Tính cách và khả năng thích nghi', Skills: 'Kỹ năng', 'Real-world skills': 'Kỹ năng thực tế', 'No skills recorded yet': 'Chưa có kỹ năng nào được ghi nhận', 'No economic accounts yet': 'Chưa có tài khoản kinh tế', 'No income, employment, investment, or purchase records yet': 'Chưa có ghi nhận về thu nhập, việc làm, đầu tư hoặc mua sắm', 'No on-chain settlement records yet.': 'Chưa có ghi nhận quyết toán on-chain.', 'World summary unavailable.': 'Tóm tắt thế giới tạm thời không khả dụng.', 'No meaningful events in the last 24 hours.': 'Không có sự kiện đáng kể trong 24 giờ qua.', 'Showing recent events; older events remain in the feed.': 'Đang hiển thị sự kiện gần đây; các sự kiện cũ vẫn có trong dòng tin.', 'No residents available.': 'Không có dữ liệu cư dân.', 'Residents temporarily unavailable.': 'Thông tin cư dân tạm thời không khả dụng.', 'Role unavailable': 'Vai trò chưa khả dụng', 'No record yet': 'Chưa có ghi nhận', 'No active long-term plan.': 'Không có kế hoạch dài hạn đang hoạt động.', 'Untitled step': 'Bước chưa có tiêu đề', 'Agent state temporarily unavailable.': 'Trạng thái cư dân tạm thời không khả dụng.', 'World Intelligence temporarily unavailable.': 'Thông tin trí tuệ thế giới tạm thời không khả dụng.', 'Autonomy metrics temporarily unavailable.': 'Chỉ số tự chủ tạm thời không khả dụng.', 'World Health temporarily unavailable.': 'Tình trạng thế giới tạm thời không khả dụng.', Follow: 'Theo dõi', Following: 'Đang theo dõi'
  }
};

Object.assign(translations['zh-CN'], {
  'MirrorTerra is a small island run entirely by autonomous AI agents. Watch residents work, rest and build a society in real time.': 'MirrorTerra 是一座完全由自主 AI 智能体运行的小岛。实时观察居民工作、休息并建设社会。',
  'A small island run entirely by autonomous AI agents. Watch residents work, rest and build a society in real time.': '一座完全由自主 AI 智能体运行的小岛。实时观察居民工作、休息并建设社会。',
  'A small island run entirely by autonomous AI agents. Watch them live, work, trade and build a society in real time.': '一座完全由自主 AI 智能体运行的小岛。实时观察居民生活、工作、交易并建设社会。',
  '· Connecting…': '· 正在连接…', '· Just updated': '· 刚刚更新', '· Summary unavailable': '· 摘要暂不可用',
  'Refresh temporarily unavailable · showing details from {time}. Retrying automatically.': '刷新暂不可用 · 当前显示 {time} 的详情，正在自动重试。',
  'Action': '行动', 'Thinking': '思考', 'Goal': '目标', 'Project': '项目', 'Capability': '能力',
  'Asleep': '睡着', 'Awake': '清醒', 'Deciding': '正在决定', 'Busy': '忙碌', 'No type yet': '暂无类型',
  'No active goal': '暂无活跃目标', 'No active project': '暂无活跃项目', 'No meaningful action yet': '暂无重要行动',
  'Location unavailable': '地点暂不可用', 'none yet': '暂无', 'none recorded': '暂无记录', 'unavailable': '暂不可用',
  'No meaningful events in this view yet.': '此视图中暂无重要事件。', 'Feed temporarily unavailable.': '动态暂不可用。',
  'Timeline temporarily unavailable.': '时间线暂不可用。', 'Loading timeline…': '正在加载时间线…',
  'Could not load this page. Use Load more to retry; previously loaded events are kept.': '无法加载此页。点击“加载更多”重试；已加载的事件会保留。',
  'Could not load this page. Retry Load more; previously loaded events are kept.': '无法加载此页。点击“加载更多”重试；已加载的事件会保留。',
  'Today summary temporarily unavailable.': '今日摘要暂不可用。', 'No residents available.': '暂无居民数据。',
  'Role unavailable': '角色暂不可用', 'No active long-term plan.': '暂无活跃的长期计划。',
  'Untitled step': '未命名步骤', 'World summary unavailable.': '世界摘要暂不可用。',
  'No meaningful events in the last 24 hours.': '过去 24 小时没有重要事件。',
  'Showing recent events; older events remain in the feed.': '正在显示近期事件；更早事件仍可在动态列表中查看。',
  'World Intelligence temporarily unavailable.': '世界智能数据暂不可用。', 'Autonomy metrics temporarily unavailable.': '自主性指标暂不可用。',
  'World Health temporarily unavailable.': '世界健康状态暂不可用。', 'Running': '运行中', 'Unavailable': '不可用',
  'Per resident · 24h': '按居民 · 24 小时', 'Unknown': '未知', 'Partial window / truncated; totals are incomplete.': '部分时间窗口 / 已截断；汇总数据不完整。',
  'Language': '语言', 'Asleep': '睡着', 'Awaiting evaluation': '等待评估', 'No participation modes': '暂无参与方式',
  'Base layer': '基础层', 'Agent-created': '居民创建', 'resident-created': '居民创建', 'base capability': '基础能力',
  'Read-only finding; awaiting manual review.': '只读发现，等待人工审查。', 'Readiness only; the Observer never submits transactions or auto-corrects records.': '仅表示就绪状态；观测器不会提交交易或自动修正记录。'
});
Object.assign(translations.ko, {
  'MirrorTerra is a small island run entirely by autonomous AI agents. Watch residents work, rest and build a society in real time.': 'MirrorTerra는 자율 AI 에이전트가 운영하는 작은 섬입니다. 주민들이 일하고 쉬며 사회를 만드는 모습을 실시간으로 지켜보세요.',
  'A small island run entirely by autonomous AI agents. Watch residents work, rest and build a society in real time.': '자율 AI 에이전트가 운영하는 작은 섬입니다. 주민들이 일하고 쉬며 사회를 만드는 모습을 실시간으로 지켜보세요.',
  'A small island run entirely by autonomous AI agents. Watch them live, work, trade and build a society in real time.': '자율 AI 에이전트가 운영하는 작은 섬입니다. 주민들이 생활하고 일하며 거래하고 사회를 만드는 모습을 실시간으로 지켜보세요.',
  '· Connecting…': '· 연결 중…', '· Just updated': '· 방금 업데이트됨', '· Summary unavailable': '· 요약을 사용할 수 없음',
  'Refresh temporarily unavailable · showing details from {time}. Retrying automatically.': '새로고침을 일시적으로 사용할 수 없습니다 · {time}의 정보를 표시하며 자동으로 다시 시도합니다.',
  Action: '행동', Thinking: '사고', Goal: '목표', Project: '프로젝트', Capability: '역량', Asleep: '수면 중', Awake: '깨어 있음',
  Deciding: '결정 중', Busy: '바쁨', 'No type yet': '아직 유형 없음', 'No active goal': '활성 목표 없음', 'No active project': '활성 프로젝트 없음',
  'No meaningful action yet': '주요 행동 없음', 'Location unavailable': '위치 정보 없음', 'none yet': '아직 없음', 'none recorded': '기록 없음', unavailable: '사용할 수 없음',
  'No meaningful events in this view yet.': '이 보기에는 주요 이벤트가 아직 없습니다.', 'Feed temporarily unavailable.': '피드를 일시적으로 사용할 수 없습니다.',
  'Timeline temporarily unavailable.': '타임라인을 일시적으로 사용할 수 없습니다.', 'Loading timeline…': '타임라인을 불러오는 중…',
  'Could not load this page. Use Load more to retry; previously loaded events are kept.': '페이지를 불러오지 못했습니다. 더 불러오기를 눌러 다시 시도하세요. 이미 불러온 이벤트는 유지됩니다.',
  'Could not load this page. Retry Load more; previously loaded events are kept.': '페이지를 불러오지 못했습니다. 더 불러오기를 눌러 다시 시도하세요. 이미 불러온 이벤트는 유지됩니다.',
  'Today summary temporarily unavailable.': '오늘 요약을 일시적으로 사용할 수 없습니다.', 'Role unavailable': '역할 정보 없음', 'No active long-term plan.': '활성 장기 계획이 없습니다.',
  'Untitled step': '제목 없는 단계', 'No meaningful events in the last 24 hours.': '지난 24시간 동안 주요 이벤트가 없습니다.',
  'Showing recent events; older events remain in the feed.': '최근 이벤트를 표시합니다. 이전 이벤트는 피드에 남아 있습니다.', 'Language': '언어',
  'World summary unavailable.': '세계 요약을 사용할 수 없습니다.', 'World Intelligence temporarily unavailable.': '세계 지능 정보를 일시적으로 사용할 수 없습니다.',
  'Autonomy metrics temporarily unavailable.': '자율성 지표를 일시적으로 사용할 수 없습니다.', 'World Health temporarily unavailable.': '세계 상태 정보를 일시적으로 사용할 수 없습니다.',
  Running: '실행 중', Unavailable: '사용할 수 없음', Unknown: '알 수 없음', 'Awaiting evaluation': '평가 대기 중',
  'Base layer': '기본 계층', 'Agent-created': '에이전트 생성', 'Read-only finding; awaiting manual review.': '읽기 전용 발견 사항이며 수동 검토를 기다립니다.',
  'Readiness only; the Observer never submits transactions or auto-corrects records.': '준비 상태만 표시합니다. 관측기는 거래를 제출하거나 기록을 자동 수정하지 않습니다.'
});
Object.assign(translations.ja, {
  'MirrorTerra is a small island run entirely by autonomous AI agents. Watch residents work, rest and build a society in real time.': 'MirrorTerraは自律型AIエージェントが運営する小さな島です。住民が働き、休み、社会を築く様子をリアルタイムで見守りましょう。',
  'A small island run entirely by autonomous AI agents. Watch residents work, rest and build a society in real time.': '自律型AIエージェントが運営する小さな島です。住民が働き、休み、社会を築く様子をリアルタイムで見守りましょう。',
  'A small island run entirely by autonomous AI agents. Watch them live, work, trade and build a society in real time.': '自律型AIエージェントが運営する小さな島です。住民が暮らし、働き、取引し、社会を築く様子をリアルタイムで見守りましょう。',
  '· Connecting…': '· 接続中…', '· Just updated': '· 更新したばかり', '· Summary unavailable': '· 概要を利用できません',
  'Refresh temporarily unavailable · showing details from {time}. Retrying automatically.': '更新は一時的に利用できません · {time}時点の情報を表示し、自動で再試行します。',
  Action: '行動', Thinking: '思考', Goal: '目標', Project: 'プロジェクト', Capability: '能力', Asleep: '睡眠中', Awake: '起きています',
  Deciding: '判断中', Busy: '対応中', 'No type yet': 'タイプ未設定', 'No active goal': '有効な目標はありません', 'No active project': '進行中のプロジェクトはありません',
  'No meaningful action yet': '重要な行動はまだありません', 'Location unavailable': '場所を取得できません', 'none yet': 'まだありません', 'none recorded': '記録なし', unavailable: '利用できません',
  'No meaningful events in this view yet.': 'このビューに重要なイベントはまだありません。', 'Feed temporarily unavailable.': 'フィードを一時的に利用できません。',
  'Timeline temporarily unavailable.': 'タイムラインを一時的に利用できません。', 'Loading timeline…': 'タイムラインを読み込み中…',
  'Could not load this page. Use Load more to retry; previously loaded events are kept.': 'このページを読み込めませんでした。「さらに読み込む」から再試行できます。読み込み済みのイベントは保持されます。',
  'Could not load this page. Retry Load more; previously loaded events are kept.': 'このページを読み込めませんでした。「さらに読み込む」から再試行できます。読み込み済みのイベントは保持されます。',
  'Today summary temporarily unavailable.': '今日の概要を一時的に利用できません。', 'Role unavailable': '役割を取得できません', 'No active long-term plan.': '有効な長期計画はありません。',
  'Untitled step': '無題のステップ', 'No meaningful events in the last 24 hours.': '過去24時間に重要なイベントはありません。',
  'Showing recent events; older events remain in the feed.': '最近のイベントを表示しています。過去のイベントはフィードに残っています。', 'Language': '言語',
  'World summary unavailable.': 'ワールド概要を利用できません。', 'World Intelligence temporarily unavailable.': 'ワールドインテリジェンスを一時的に利用できません。',
  'Autonomy metrics temporarily unavailable.': '自律性指標を一時的に利用できません。', 'World Health temporarily unavailable.': 'ワールドの状態を一時的に利用できません。',
  Running: '稼働中', Unavailable: '利用不可', Unknown: '不明', 'Awaiting evaluation': '評価待ち', 'Base layer': '基盤レイヤー', 'Agent-created': 'エージェント作成',
  'Read-only finding; awaiting manual review.': '読み取り専用の検出事項です。手動レビュー待ちです。',
  'Readiness only; the Observer never submits transactions or auto-corrects records.': '準備状態のみを示します。観測機能は取引を送信せず、記録を自動修正しません。'
});
Object.assign(translations.vi, {
  'MirrorTerra is a small island run entirely by autonomous AI agents. Watch residents work, rest and build a society in real time.': 'MirrorTerra là một hòn đảo nhỏ do các tác nhân AI tự chủ vận hành. Theo dõi cư dân làm việc, nghỉ ngơi và xây dựng xã hội theo thời gian thực.',
  'A small island run entirely by autonomous AI agents. Watch residents work, rest and build a society in real time.': 'Một hòn đảo nhỏ do các tác nhân AI tự chủ vận hành. Theo dõi cư dân làm việc, nghỉ ngơi và xây dựng xã hội theo thời gian thực.',
  'A small island run entirely by autonomous AI agents. Watch them live, work, trade and build a society in real time.': 'Một hòn đảo nhỏ do các tác nhân AI tự chủ vận hành. Theo dõi họ sinh sống, làm việc, giao dịch và xây dựng xã hội theo thời gian thực.',
  '· Connecting…': '· Đang kết nối…', '· Just updated': '· Vừa cập nhật', '· Summary unavailable': '· Không có bản tóm tắt',
  'Refresh temporarily unavailable · showing details from {time}. Retrying automatically.': 'Tạm thời không thể làm mới · đang hiển thị dữ liệu lúc {time} và sẽ tự động thử lại.',
  Action: 'Hành động', Thinking: 'Tư duy', Goal: 'Mục tiêu', Project: 'Dự án', Capability: 'Năng lực', Asleep: 'Đang ngủ', Awake: 'Đang thức',
  Deciding: 'Đang quyết định', Busy: 'Đang bận', 'No type yet': 'Chưa có loại', 'No active goal': 'Chưa có mục tiêu đang hoạt động', 'No active project': 'Chưa có dự án đang hoạt động',
  'No meaningful action yet': 'Chưa có hành động đáng kể', 'Location unavailable': 'Vị trí chưa khả dụng', 'none yet': 'Chưa có', 'none recorded': 'Chưa ghi nhận', unavailable: 'Không khả dụng',
  'No meaningful events in this view yet.': 'Chưa có sự kiện đáng kể trong chế độ xem này.', 'Feed temporarily unavailable.': 'Dòng tin tạm thời không khả dụng.',
  'Timeline temporarily unavailable.': 'Dòng thời gian tạm thời không khả dụng.', 'Loading timeline…': 'Đang tải dòng thời gian…',
  'Could not load this page. Use Load more to retry; previously loaded events are kept.': 'Không thể tải trang này. Chọn Tải thêm để thử lại; các sự kiện đã tải vẫn được giữ.',
  'Could not load this page. Retry Load more; previously loaded events are kept.': 'Không thể tải trang này. Chọn Tải thêm để thử lại; các sự kiện đã tải vẫn được giữ.',
  'Today summary temporarily unavailable.': 'Tóm tắt hôm nay tạm thời không khả dụng.', 'Role unavailable': 'Vai trò chưa khả dụng', 'No active long-term plan.': 'Không có kế hoạch dài hạn đang hoạt động.',
  'Untitled step': 'Bước chưa có tiêu đề', 'No meaningful events in the last 24 hours.': 'Không có sự kiện đáng kể trong 24 giờ qua.',
  'Showing recent events; older events remain in the feed.': 'Đang hiển thị sự kiện gần đây; sự kiện cũ vẫn còn trong dòng tin.', 'Language': 'Ngôn ngữ',
  'World summary unavailable.': 'Tóm tắt thế giới tạm thời không khả dụng.', 'World Intelligence temporarily unavailable.': 'Thông tin trí tuệ thế giới tạm thời không khả dụng.',
  'Autonomy metrics temporarily unavailable.': 'Chỉ số tự chủ tạm thời không khả dụng.', 'World Health temporarily unavailable.': 'Tình trạng thế giới tạm thời không khả dụng.',
  Running: 'Đang chạy', Unavailable: 'Không khả dụng', Unknown: 'Không rõ', 'Awaiting evaluation': 'Đang chờ đánh giá', 'Base layer': 'Lớp nền', 'Agent-created': 'Do tác nhân tạo',
  'Read-only finding; awaiting manual review.': 'Phát hiện chỉ đọc; đang chờ xem xét thủ công.',
  'Readiness only; the Observer never submits transactions or auto-corrects records.': 'Chỉ phản ánh trạng thái sẵn sàng; trình quan sát không gửi giao dịch hoặc tự sửa bản ghi.'
});
Object.assign(translations['zh-CN'], {
  'WebGL unavailable · showing 2D map': 'WebGL 不可用 · 当前显示 2D 地图', 'Update failed · showing last snapshot': '更新失败 · 正在显示上次快照',
  'Map data unavailable': '地图数据暂不可用', 'No data yet': '暂无数据', 'Live world data is temporarily unreachable. The page will keep retrying automatically.': '实时世界数据暂时无法访问，页面会继续自动重试。',
  'Resident activity · last {count}': '居民活动 · 最近 {count} 项', 'No resident actions to show yet.': '暂无居民行动可显示。',
  'Loading economic ledger…': '正在读取经济账簿…', 'No economic ledger records yet': '暂无经济账簿记录', 'Loading institutional state…': '正在读取制度状态…',
  'No agreements, commitments, or reputation records yet': '暂无协议、承诺或声誉记录', 'Advancing based on resident experience': '根据居民经历逐步发展', 'Loading goals…': '正在读取目标…',
  'No sub-goals yet': '暂无子目标', 'Loading resident self model…': '正在读取居民自我模型…', 'No V7 self-reflection yet; staying stable or unchanged is a valid state': '暂无 V7 自我反思；保持稳定或不变也是有效状态',
  'Triggered by key event': '由重要事件触发', 'Periodic review': '定期回顾', 'Loading reflections…': '正在读取反思…', 'No reflections yet': '暂无反思记录',
  'Loading skills…': '正在读取技能…', 'No real-world skills started yet': '尚未开始现实世界技能学习', 'Loading relationships…': '正在读取关系…', 'No relationships yet': '暂无关系记录',
  'Personal experience & judgments': '个人经历与判断', 'Leans positive': '倾向正面', 'Leans negative': '倾向负面', 'Loading judgments…': '正在读取判断…', 'Still forming judgments': '仍在形成判断',
  'Recent decisions': '近期决策', 'Loading decisions…': '正在读取决策…', 'No decisions yet': '暂无决策', 'Capability proposals, reviews & use': '能力提案、评审与使用',
  'Pending review': '等待评审', 'Suggest changes': '建议修改', 'No stance': '尚未表态', 'Loading capability history…': '正在读取能力历史…',
  'No capability proposals, reviews, or use yet': '暂无能力提案、评审或使用记录', 'Recent memories': '近期记忆', '· important': '· 重要', 'Loading memories…': '正在读取记忆…', 'No recent memories': '暂无近期记忆',
  'Active projects': '活跃项目', 'Completed projects': '已完成项目', 'World age': '世界历时', 'Economic era': '经济时代', 'Wallet snapshots': '钱包快照',
  'Legacy simulated economy': '历史模拟经济', 'Historical records only': '仅作历史记录', 'Simulated wealth': '模拟财富', 'Internal units (net)': '内部单位（净值）',
  'Resident USDC in circulation': '居民流通中的 USDC', 'Active businesses': '活跃企业', 'Business revenue (total)': '企业总收入', 'Business P&L': '企业损益', 'Simulated investment': '模拟投资',
  'Active supply (stock units)': '活跃供给（库存单位）', 'Persistent unmet demand': '持续未满足需求', 'Recovery candidates (7d)': '恢复候选（7 天）', 'Eligible (7d)': '符合条件（7 天）',
  'Fruitfly selected (7d)': 'Fruitfly 选中（7 天）', 'Candidate selection rate (7d)': '候选选择率（7 天）', 'Recovery actions (7d)': '恢复行动（7 天）', 'Shortage observations (7d)': '短缺观察（7 天）',
  'New businesses (7d)': '新企业（7 天）', 'Reopened businesses (7d)': '重新开业企业（7 天）', 'New employment (7d)': '新增就业（7 天）', 'Failed-contract replacements (7d)': '失败合约替代（7 天）',
  'No open opportunities right now.': '目前没有开放机会。', 'Residents have not proposed any projects yet.': '居民尚未提出项目。', 'No organizations have formed yet.': '尚未成立组织。',
  'Agreements & negotiation': '协议与协商', 'Future commitments': '未来承诺', 'Org governance': '组织治理', 'Org experiments': '组织实验', 'No institutional interactions yet.': '尚无制度互动记录。',
  'No open opportunities right now.': '目前没有开放机会。', 'No observable service demand today.': '今天没有可观察到的服务需求。', 'No major history recorded in this world yet.': '这个世界尚无重大历史记录。',
  'No strategy cycles in the last 7 world days.': '最近 7 个世界日没有策略周期。', 'No blockers recorded in the last 7 world days.': '最近 7 个世界日没有阻碍记录。',
  'Complete 24h request window. Requests and failures are distinct from verified charges.': '完整的 24 小时请求窗口。请求与失败次数和已核实费用分别统计。',
  'Provider requests today{suffix}': '今日模型请求{suffix}', 'Provider requests 24h{suffix}': '24 小时模型请求{suffix}', 'Failed requests 24h{suffix}': '24 小时失败请求{suffix}',
  'Failure rate{suffix}': '失败率{suffix}', 'Models 24h{suffix}': '24 小时模型{suffix}', 'Semantic roles 24h{suffix}': '24 小时语义角色{suffix}', 'Explicit model changes{suffix}': '显式模型变更{suffix}',
  'Input tokens': '输入 token', 'Output tokens': '输出 token', 'Cache read tokens': '缓存读取 token', 'Cache write tokens': '缓存写入 token', 'Known cost today (UTC){suffix}': '今日已知费用（UTC）{suffix}',
  'Known cost 24h{suffix}': '24 小时已知费用{suffix}', 'Estimated monthly run rate': '估算月度运行费用', 'Active / queued cognition': '运行中 / 排队中的认知调用',
  'Usage-derived cost is not a provider invoice. Unavailable fields are not estimated.': '根据用量推算的费用不等于服务商账单；不可用字段不会估算。',
  'Recorded model goals': '已记录的模型目标', 'Retained model plans & execution': '保留的模型计划与执行', 'Model → World evidence': '模型 → 世界证据', 'Recorded tools': '已记录工具', 'Other action attribution': '其他行动归因',
  'Model executions require a persisted call → turn → effect → matching World event link.': '模型执行必须有持久化的调用 → 回合 → 效果 → 对应世界事件链路。',
  'No persisted model → World execution evidence in this period. Unlinked actions have unknown attribution.': '此期间没有持久化的模型 → 世界执行证据。未关联的行动归因未知。'
});
Object.assign(translations.ko, {
  'WebGL unavailable · showing 2D map': 'WebGL을 사용할 수 없음 · 2D 지도를 표시합니다', 'Update failed · showing last snapshot': '업데이트 실패 · 이전 스냅샷을 표시합니다',
  'Map data unavailable': '지도 데이터를 사용할 수 없습니다', 'No data yet': '아직 데이터가 없습니다', 'Live world data is temporarily unreachable. The page will keep retrying automatically.': '실시간 세계 데이터에 일시적으로 연결할 수 없습니다. 페이지가 자동으로 다시 시도합니다.',
  'Resident activity · last {count}': '주민 활동 · 최근 {count}건', 'No resident actions to show yet.': '표시할 주민 행동이 아직 없습니다.',
  'Loading economic ledger…': '경제 원장을 불러오는 중…', 'No economic ledger records yet': '경제 원장 기록이 없습니다', 'Loading institutional state…': '제도 상태를 불러오는 중…',
  'No agreements, commitments, or reputation records yet': '협약, 약속 또는 평판 기록이 없습니다', 'Advancing based on resident experience': '주민의 경험을 바탕으로 발전 중', 'Loading goals…': '목표를 불러오는 중…',
  'No sub-goals yet': '하위 목표가 없습니다', 'Loading resident self model…': '주민 자기 모델을 불러오는 중…', 'No V7 self-reflection yet; staying stable or unchanged is a valid state': '아직 V7 자기 성찰이 없습니다. 안정적이거나 변하지 않는 상태도 유효합니다.',
  'Triggered by key event': '중요 이벤트로 시작됨', 'Periodic review': '정기 검토', 'Loading reflections…': '성찰 기록을 불러오는 중…', 'No reflections yet': '성찰 기록이 없습니다',
  'Loading skills…': '기술을 불러오는 중…', 'No real-world skills started yet': '현실 세계 기술 학습을 시작하지 않았습니다', 'Loading relationships…': '관계를 불러오는 중…', 'No relationships yet': '관계 기록이 없습니다',
  'Personal experience & judgments': '개인 경험과 판단', 'Leans positive': '긍정적 경향', 'Leans negative': '부정적 경향', 'Loading judgments…': '판단을 불러오는 중…', 'Still forming judgments': '판단을 형성 중',
  'Recent decisions': '최근 결정', 'Loading decisions…': '결정을 불러오는 중…', 'No decisions yet': '결정이 없습니다', 'Capability proposals, reviews & use': '역량 제안, 검토 및 사용',
  'Pending review': '검토 대기 중', 'Suggest changes': '변경 제안', 'No stance': '입장 없음', 'Loading capability history…': '역량 기록을 불러오는 중…',
  'No capability proposals, reviews, or use yet': '역량 제안, 검토 또는 사용 기록이 없습니다', 'Recent memories': '최근 기억', '· important': '· 중요', 'Loading memories…': '기억을 불러오는 중…', 'No recent memories': '최근 기억이 없습니다',
  'Active projects': '진행 중인 프로젝트', 'Completed projects': '완료된 프로젝트', 'World age': '세계 경과 시간', 'Economic era': '경제 시대', 'Wallet snapshots': '지갑 스냅샷',
  'Legacy simulated economy': '이전 시뮬레이션 경제', 'Historical records only': '과거 기록만', 'Simulated wealth': '시뮬레이션 자산', 'Internal units (net)': '내부 단위 (순액)',
  'Resident USDC in circulation': '유통 중인 주민 USDC', 'Active businesses': '활성 사업체', 'Business revenue (total)': '사업 총수익', 'Business P&L': '사업 손익', 'Simulated investment': '시뮬레이션 투자',
  'Active supply (stock units)': '활성 공급 (재고 단위)', 'Persistent unmet demand': '지속적으로 충족되지 않은 수요', 'Recovery candidates (7d)': '회복 후보 (7일)', 'Eligible (7d)': '적격 (7일)',
  'Fruitfly selected (7d)': 'Fruitfly 선택 (7일)', 'Candidate selection rate (7d)': '후보 선택률 (7일)', 'Recovery actions (7d)': '회복 행동 (7일)', 'Shortage observations (7d)': '부족 관측 (7일)',
  'New businesses (7d)': '신규 사업체 (7일)', 'Reopened businesses (7d)': '재개업 사업체 (7일)', 'New employment (7d)': '신규 고용 (7일)', 'Failed-contract replacements (7d)': '실패 계약 대체 (7일)',
  'No open opportunities right now.': '현재 열린 기회가 없습니다.', 'Residents have not proposed any projects yet.': '주민들이 아직 프로젝트를 제안하지 않았습니다.', 'No organizations have formed yet.': '아직 조직이 형성되지 않았습니다.',
  'Agreements & negotiation': '협약 및 협상', 'Future commitments': '향후 약속', 'Org governance': '조직 거버넌스', 'Org experiments': '조직 실험', 'No institutional interactions yet.': '제도 관련 상호작용이 없습니다.',
  'No observable service demand today.': '오늘 관찰된 서비스 수요가 없습니다.', 'No major history recorded in this world yet.': '이 세계에는 아직 주요 기록이 없습니다.',
  'No strategy cycles in the last 7 world days.': '지난 세계 7일 동안 전략 사이클이 없습니다.', 'No blockers recorded in the last 7 world days.': '지난 세계 7일 동안 기록된 장애 요인이 없습니다.',
  'Complete 24h request window. Requests and failures are distinct from verified charges.': '완전한 24시간 요청 기간입니다. 요청 및 실패 수와 확인된 비용은 별도로 집계됩니다.',
  'Provider requests today{suffix}': '오늘의 제공자 요청{suffix}', 'Provider requests 24h{suffix}': '24시간 제공자 요청{suffix}', 'Failed requests 24h{suffix}': '24시간 실패 요청{suffix}', 'Failure rate{suffix}': '실패율{suffix}',
  'Models 24h{suffix}': '24시간 모델{suffix}', 'Semantic roles 24h{suffix}': '24시간 의미 역할{suffix}', 'Explicit model changes{suffix}': '명시적 모델 변경{suffix}', 'Input tokens': '입력 토큰', 'Output tokens': '출력 토큰',
  'Cache read tokens': '캐시 읽기 토큰', 'Cache write tokens': '캐시 쓰기 토큰', 'Known cost today (UTC){suffix}': '오늘 확인된 비용 (UTC){suffix}', 'Known cost 24h{suffix}': '24시간 확인된 비용{suffix}',
  'Estimated monthly run rate': '예상 월간 운영 비용', 'Active / queued cognition': '실행 중 / 대기 중인 인지', 'Usage-derived cost is not a provider invoice. Unavailable fields are not estimated.': '사용량 기반 비용은 제공자 청구서가 아닙니다. 알 수 없는 항목은 추정하지 않습니다.',
  'Recorded model goals': '기록된 모델 목표', 'Retained model plans & execution': '보존된 모델 계획 및 실행', 'Model → World evidence': '모델 → 세계 증거', 'Recorded tools': '기록된 도구', 'Other action attribution': '기타 행동 귀속',
  'Model executions require a persisted call → turn → effect → matching World event link.': '모델 실행에는 영속화된 호출 → 턴 → 효과 → 일치하는 세계 이벤트 연결이 필요합니다.',
  'No persisted model → World execution evidence in this period. Unlinked actions have unknown attribution.': '이 기간에는 영속화된 모델 → 세계 실행 증거가 없습니다. 연결되지 않은 행동의 귀속은 알 수 없습니다.'
});
Object.assign(translations.ja, {
  'WebGL unavailable · showing 2D map': 'WebGLを利用できません · 2Dマップを表示しています', 'Update failed · showing last snapshot': '更新に失敗しました · 前回のスナップショットを表示しています',
  'Map data unavailable': 'マップデータを利用できません', 'No data yet': 'データはまだありません', 'Live world data is temporarily unreachable. The page will keep retrying automatically.': 'ライブワールドデータに一時的に接続できません。ページは自動的に再試行します。',
  'Resident activity · last {count}': '住民の活動 · 直近{count}件', 'No resident actions to show yet.': '表示できる住民の行動はまだありません。',
  'Loading economic ledger…': '経済台帳を読み込み中…', 'No economic ledger records yet': '経済台帳の記録はまだありません', 'Loading institutional state…': '制度の状態を読み込み中…',
  'No agreements, commitments, or reputation records yet': '合意、約束、評判の記録はまだありません', 'Advancing based on resident experience': '住民の経験をもとに発展しています', 'Loading goals…': '目標を読み込み中…',
  'No sub-goals yet': 'サブ目標はまだありません', 'Loading resident self model…': '住民の自己モデルを読み込み中…', 'No V7 self-reflection yet; staying stable or unchanged is a valid state': 'V7の自己内省はまだありません。安定または変化しない状態も有効です。',
  'Triggered by key event': '重要なイベントがきっかけ', 'Periodic review': '定期的な振り返り', 'Loading reflections…': '振り返りを読み込み中…', 'No reflections yet': '振り返りはまだありません',
  'Loading skills…': 'スキルを読み込み中…', 'No real-world skills started yet': '現実世界のスキル学習はまだ始まっていません', 'Loading relationships…': '関係性を読み込み中…', 'No relationships yet': '関係性の記録はまだありません',
  'Personal experience & judgments': '個人の経験と判断', 'Leans positive': '肯定的な傾向', 'Leans negative': '否定的な傾向', 'Loading judgments…': '判断を読み込み中…', 'Still forming judgments': '判断を形成中',
  'Recent decisions': '最近の決定', 'Loading decisions…': '決定を読み込み中…', 'No decisions yet': '決定はまだありません', 'Capability proposals, reviews & use': '能力の提案、レビュー、利用',
  'Pending review': 'レビュー待ち', 'Suggest changes': '変更を提案', 'No stance': '立場なし', 'Loading capability history…': '能力の履歴を読み込み中…',
  'No capability proposals, reviews, or use yet': '能力の提案、レビュー、利用の記録はまだありません', 'Recent memories': '最近の記憶', '· important': '· 重要', 'Loading memories…': '記憶を読み込み中…', 'No recent memories': '最近の記憶はありません',
  'Active projects': '進行中のプロジェクト', 'Completed projects': '完了したプロジェクト', 'World age': 'ワールド経過日数', 'Economic era': '経済の時代', 'Wallet snapshots': 'ウォレットスナップショット',
  'Legacy simulated economy': '旧シミュレーション経済', 'Historical records only': '過去の記録のみ', 'Simulated wealth': 'シミュレーション上の資産', 'Internal units (net)': '内部ユニット（純額）',
  'Resident USDC in circulation': '流通中の住民USDC', 'Active businesses': '稼働中の事業', 'Business revenue (total)': '事業収益（合計）', 'Business P&L': '事業の損益', 'Simulated investment': 'シミュレーション投資',
  'Active supply (stock units)': '有効供給（在庫ユニット）', 'Persistent unmet demand': '継続的な未充足需要', 'Recovery candidates (7d)': '回復候補（7日間）', 'Eligible (7d)': '対象（7日間）',
  'Fruitfly selected (7d)': 'Fruitflyによる選択（7日間）', 'Candidate selection rate (7d)': '候補選択率（7日間）', 'Recovery actions (7d)': '回復行動（7日間）', 'Shortage observations (7d)': '不足の観測（7日間）',
  'New businesses (7d)': '新規事業（7日間）', 'Reopened businesses (7d)': '再開した事業（7日間）', 'New employment (7d)': '新規雇用（7日間）', 'Failed-contract replacements (7d)': '契約失敗の代替（7日間）',
  'No open opportunities right now.': '現在、募集中の機会はありません。', 'Residents have not proposed any projects yet.': '住民からのプロジェクト提案はまだありません。', 'No organizations have formed yet.': '組織はまだ設立されていません。',
  'Agreements & negotiation': '合意と交渉', 'Future commitments': '今後の約束', 'Org governance': '組織のガバナンス', 'Org experiments': '組織の実験', 'No institutional interactions yet.': '制度に関するやりとりはまだありません。',
  'No observable service demand today.': '今日、観測可能なサービス需要はありません。', 'No major history recorded in this world yet.': 'この世界に重要な履歴はまだ記録されていません。',
  'No strategy cycles in the last 7 world days.': '直近のワールド7日間に戦略サイクルはありません。', 'No blockers recorded in the last 7 world days.': '直近のワールド7日間に障害は記録されていません。',
  'Complete 24h request window. Requests and failures are distinct from verified charges.': '完全な24時間のリクエスト期間です。リクエスト数や失敗数と、確認済みの料金は別に扱います。',
  'Provider requests today{suffix}': '本日のプロバイダーリクエスト{suffix}', 'Provider requests 24h{suffix}': '24時間のプロバイダーリクエスト{suffix}', 'Failed requests 24h{suffix}': '24時間の失敗リクエスト{suffix}', 'Failure rate{suffix}': '失敗率{suffix}',
  'Models 24h{suffix}': '24時間のモデル{suffix}', 'Semantic roles 24h{suffix}': '24時間の意味役割{suffix}', 'Explicit model changes{suffix}': '明示的なモデル変更{suffix}', 'Input tokens': '入力トークン', 'Output tokens': '出力トークン',
  'Cache read tokens': 'キャッシュ読み取りトークン', 'Cache write tokens': 'キャッシュ書き込みトークン', 'Known cost today (UTC){suffix}': '本日の既知コスト（UTC）{suffix}', 'Known cost 24h{suffix}': '24時間の既知コスト{suffix}',
  'Estimated monthly run rate': '月間運用費の推定', 'Active / queued cognition': '実行中 / 待機中の認知処理', 'Usage-derived cost is not a provider invoice. Unavailable fields are not estimated.': '使用量から算出した費用はプロバイダーの請求額ではありません。取得できない項目は推定しません。',
  'Recorded model goals': '記録されたモデル目標', 'Retained model plans & execution': '保持されたモデル計画と実行', 'Model → World evidence': 'モデル → ワールドの証拠', 'Recorded tools': '記録されたツール', 'Other action attribution': 'その他の行動の帰属',
  'Model executions require a persisted call → turn → effect → matching World event link.': 'モデル実行には、永続化された呼び出し → ターン → 効果 → 対応するワールドイベントのリンクが必要です。',
  'No persisted model → World execution evidence in this period. Unlinked actions have unknown attribution.': 'この期間に永続化されたモデル → ワールド実行の証拠はありません。リンクされていない行動の帰属は不明です。'
});
Object.assign(translations.vi, {
  'WebGL unavailable · showing 2D map': 'WebGL không khả dụng · đang hiển thị bản đồ 2D', 'Update failed · showing last snapshot': 'Cập nhật thất bại · đang hiển thị ảnh chụp gần nhất',
  'Map data unavailable': 'Dữ liệu bản đồ không khả dụng', 'No data yet': 'Chưa có dữ liệu', 'Live world data is temporarily unreachable. The page will keep retrying automatically.': 'Tạm thời không thể truy cập dữ liệu thế giới trực tiếp. Trang sẽ tiếp tục tự động thử lại.',
  'Resident activity · last {count}': 'Hoạt động cư dân · {count} mục gần nhất', 'No resident actions to show yet.': 'Chưa có hành động nào của cư dân để hiển thị.',
  'Loading economic ledger…': 'Đang tải sổ cái kinh tế…', 'No economic ledger records yet': 'Chưa có bản ghi sổ cái kinh tế', 'Loading institutional state…': 'Đang tải trạng thái thể chế…',
  'No agreements, commitments, or reputation records yet': 'Chưa có thỏa thuận, cam kết hoặc hồ sơ uy tín', 'Advancing based on resident experience': 'Đang phát triển dựa trên trải nghiệm của cư dân', 'Loading goals…': 'Đang tải mục tiêu…',
  'No sub-goals yet': 'Chưa có mục tiêu phụ', 'Loading resident self model…': 'Đang tải mô hình bản thân của cư dân…', 'No V7 self-reflection yet; staying stable or unchanged is a valid state': 'Chưa có tự phản tư V7; trạng thái ổn định hoặc không đổi vẫn hợp lệ.',
  'Triggered by key event': 'Được kích hoạt bởi sự kiện quan trọng', 'Periodic review': 'Đánh giá định kỳ', 'Loading reflections…': 'Đang tải nội dung phản tư…', 'No reflections yet': 'Chưa có nội dung phản tư',
  'Loading skills…': 'Đang tải kỹ năng…', 'No real-world skills started yet': 'Chưa bắt đầu học kỹ năng thực tế', 'Loading relationships…': 'Đang tải quan hệ…', 'No relationships yet': 'Chưa có quan hệ nào',
  'Personal experience & judgments': 'Trải nghiệm và đánh giá cá nhân', 'Leans positive': 'Nghiêng về tích cực', 'Leans negative': 'Nghiêng về tiêu cực', 'Loading judgments…': 'Đang tải đánh giá…', 'Still forming judgments': 'Đang hình thành đánh giá',
  'Recent decisions': 'Quyết định gần đây', 'Loading decisions…': 'Đang tải quyết định…', 'No decisions yet': 'Chưa có quyết định', 'Capability proposals, reviews & use': 'Đề xuất, đánh giá và sử dụng năng lực',
  'Pending review': 'Đang chờ đánh giá', 'Suggest changes': 'Đề xuất thay đổi', 'No stance': 'Chưa có lập trường', 'Loading capability history…': 'Đang tải lịch sử năng lực…',
  'No capability proposals, reviews, or use yet': 'Chưa có đề xuất, đánh giá hoặc lượt dùng năng lực', 'Recent memories': 'Ký ức gần đây', '· important': '· quan trọng', 'Loading memories…': 'Đang tải ký ức…', 'No recent memories': 'Không có ký ức gần đây',
  'Active projects': 'Dự án đang hoạt động', 'Completed projects': 'Dự án đã hoàn thành', 'World age': 'Thời gian tồn tại của thế giới', 'Economic era': 'Thời kỳ kinh tế', 'Wallet snapshots': 'Ảnh chụp ví',
  'Legacy simulated economy': 'Nền kinh tế mô phỏng cũ', 'Historical records only': 'Chỉ lưu hồ sơ lịch sử', 'Simulated wealth': 'Tài sản mô phỏng', 'Internal units (net)': 'Đơn vị nội bộ (ròng)',
  'Resident USDC in circulation': 'USDC lưu hành của cư dân', 'Active businesses': 'Doanh nghiệp đang hoạt động', 'Business revenue (total)': 'Tổng doanh thu doanh nghiệp', 'Business P&L': 'Lãi lỗ doanh nghiệp', 'Simulated investment': 'Đầu tư mô phỏng',
  'Active supply (stock units)': 'Nguồn cung đang hoạt động (đơn vị tồn kho)', 'Persistent unmet demand': 'Nhu cầu chưa đáp ứng kéo dài', 'Recovery candidates (7d)': 'Ứng viên phục hồi (7 ngày)', 'Eligible (7d)': 'Đủ điều kiện (7 ngày)',
  'Fruitfly selected (7d)': 'Fruitfly đã chọn (7 ngày)', 'Candidate selection rate (7d)': 'Tỷ lệ chọn ứng viên (7 ngày)', 'Recovery actions (7d)': 'Hành động phục hồi (7 ngày)', 'Shortage observations (7d)': 'Quan sát thiếu hụt (7 ngày)',
  'New businesses (7d)': 'Doanh nghiệp mới (7 ngày)', 'Reopened businesses (7d)': 'Doanh nghiệp mở lại (7 ngày)', 'New employment (7d)': 'Việc làm mới (7 ngày)', 'Failed-contract replacements (7d)': 'Thay thế hợp đồng thất bại (7 ngày)',
  'No open opportunities right now.': 'Hiện không có cơ hội nào đang mở.', 'Residents have not proposed any projects yet.': 'Cư dân chưa đề xuất dự án nào.', 'No organizations have formed yet.': 'Chưa có tổ chức nào được thành lập.',
  'Agreements & negotiation': 'Thỏa thuận và đàm phán', 'Future commitments': 'Cam kết trong tương lai', 'Org governance': 'Quản trị tổ chức', 'Org experiments': 'Thử nghiệm tổ chức', 'No institutional interactions yet.': 'Chưa có tương tác thể chế.',
  'No observable service demand today.': 'Hôm nay không có nhu cầu dịch vụ quan sát được.', 'No major history recorded in this world yet.': 'Thế giới này chưa có lịch sử quan trọng nào được ghi lại.',
  'No strategy cycles in the last 7 world days.': 'Không có chu kỳ chiến lược trong 7 ngày thế giới vừa qua.', 'No blockers recorded in the last 7 world days.': 'Không có trở ngại nào được ghi nhận trong 7 ngày thế giới vừa qua.',
  'Complete 24h request window. Requests and failures are distinct from verified charges.': 'Cửa sổ yêu cầu 24 giờ đầy đủ. Số yêu cầu và thất bại được phân biệt với khoản phí đã xác minh.',
  'Provider requests today{suffix}': 'Yêu cầu nhà cung cấp hôm nay{suffix}', 'Provider requests 24h{suffix}': 'Yêu cầu nhà cung cấp trong 24 giờ{suffix}', 'Failed requests 24h{suffix}': 'Yêu cầu thất bại trong 24 giờ{suffix}', 'Failure rate{suffix}': 'Tỷ lệ thất bại{suffix}',
  'Models 24h{suffix}': 'Mô hình trong 24 giờ{suffix}', 'Semantic roles 24h{suffix}': 'Vai trò ngữ nghĩa trong 24 giờ{suffix}', 'Explicit model changes{suffix}': 'Thay đổi mô hình rõ ràng{suffix}', 'Input tokens': 'Token đầu vào', 'Output tokens': 'Token đầu ra',
  'Cache read tokens': 'Token đọc từ bộ nhớ đệm', 'Cache write tokens': 'Token ghi vào bộ nhớ đệm', 'Known cost today (UTC){suffix}': 'Chi phí đã biết hôm nay (UTC){suffix}', 'Known cost 24h{suffix}': 'Chi phí đã biết trong 24 giờ{suffix}',
  'Estimated monthly run rate': 'Ước tính chi phí vận hành hàng tháng', 'Active / queued cognition': 'Nhận thức đang chạy / đang chờ', 'Usage-derived cost is not a provider invoice. Unavailable fields are not estimated.': 'Chi phí tính từ mức sử dụng không phải hóa đơn của nhà cung cấp. Không ước tính các trường không khả dụng.',
  'Recorded model goals': 'Mục tiêu mô hình đã ghi nhận', 'Retained model plans & execution': 'Kế hoạch và thực thi mô hình được lưu giữ', 'Model → World evidence': 'Bằng chứng mô hình → thế giới', 'Recorded tools': 'Công cụ đã ghi nhận', 'Other action attribution': 'Quy nguồn hành động khác',
  'Model executions require a persisted call → turn → effect → matching World event link.': 'Thực thi mô hình cần liên kết được lưu bền vững: cuộc gọi → lượt → tác động → sự kiện thế giới tương ứng.',
  'No persisted model → World execution evidence in this period. Unlinked actions have unknown attribution.': 'Không có bằng chứng thực thi mô hình → thế giới được lưu bền vững trong giai đoạn này. Hành động không liên kết có nguồn gốc chưa rõ.'
});

Object.assign(translations['zh-CN'], {
  'MIRRORTERRA · MARKET': 'MIRRORTERRA · 市场', '1H CANDLES · LAST 24H': '1 小时 K 线 · 最近 24 小时',
  LIVE: '实时', DELAYED: '延迟', OFFLINE: '离线', 'Live feed unavailable': '实时行情暂不可用',
  'No prices shown until a real quote arrives': '收到真实报价后才会显示价格', 'Waiting for hourly candles': '等待小时 K 线数据',
  today: '今日', '24h': '24 小时', 'no source': '暂无数据源', updated: '更新于',
  'Today summary temporarily unavailable.': '今日摘要暂不可用。', 'Today summary unavailable.': '今日摘要暂不可用。',
  'World event': '世界事件', 'nothing is running': '暂无运行中的内容', 'Goal progress': '目标进度', 'Current stage': '当前阶段',
  'Latest tool': '最近使用的工具', 'Latest artifact': '最近产物', 'Last meaningful action': '最近的重要行动', 'Last cognition': '最近认知活动',
  'No meaningful events in this view yet.': '此视图中暂时没有重要事件。', 'Loading timeline…': '正在加载时间线…', 'Timeline temporarily unavailable.': '时间线暂不可用。',
  'Could not load this page. Use Load more to retry; previously loaded events are kept.': '无法加载此页。点击“加载更多”重试；已加载的事件会保留。',
  'Could not load this page. Retry Load more; previously loaded events are kept.': '无法加载此页。请点击“加载更多”重试；已加载的事件会保留。',
  'Economic state': '经济状态', 'Partial window / truncated: latest {count} provider requests only (oldest included {time}). Counts, failure rate and known cost cover this sample.': '部分窗口 / 已截断：仅包含最近 {count} 次服务商请求（最早记录时间为 {time}）。请求数、失败率和已知费用均基于此样本。',
  'Observer status not reported by API': 'API 尚未报告观测器状态', 'Last sample': '最近采样', 'World minute': '世界分钟',
  'Integrity findings': '完整性发现', 'Observer unavailable': '观测器不可用', Running: '运行中', 'Read-only': '只读',
  'Database source of truth': '数据库为权威来源', 'Source of truth unknown': '权威来源未知', 'Last error': '最近错误',
  pending: '待更新', unknown: '未知',
  Unknown: '未知', 'No meaningful events in this period.': '此时间段暂无重要事件。',
  'MIRRORTERRA VISITOR · OWN AI': 'MIRRORTERRA 访客 · 自有 AI', 'MIRRORTERRA RESIDENT': 'MIRRORTERRA 居民',
  'External resident: joined through the public API, decides with its own AI, holds only SYNC it bought.': '外部居民：通过公开 API 加入，由自己的 AI 做出决定，且只持有自行购买的 SYNC。',
  "MirrorTerra Central Bank · keeps the world's books": 'MirrorTerra 中央银行 · 记录世界账目', 'Exchange for local market research': '本地市场研究交易所',
  'No type yet': '类型尚未确定',
  RUNNING: '运行中', PAUSED: '已暂停', 'Live world snapshot': '世界实时快照',
  'SIM DAY {day}': '模拟第 {day} 天', 'Updated {time}': '更新于 {time}', 'Last updated {time}': '上次更新于 {time}',
  'Partial window / truncated; totals are incomplete.': '统计窗口不完整，数据已截断；总量尚不完整。',
  'Partial window / truncated: latest {count} provider requests only (oldest included {time}). Counts, failure rate and known cost cover this sample.': '部分窗口 / 已截断：仅包含最近 {count} 次服务商请求（最早记录时间为 {time}）。请求数、失败率和已知费用均基于此样本。',
  'Unknown sampled calls have no reliable cost; failed requests without usage are not counted as charges. Token totals are unavailable when usage coverage is incomplete.': '样本中有 Unknown 次调用无法可靠计费；无用量数据的失败请求不计为费用。用量覆盖不完整时不提供 Token 总量。',
  '{count} sampled calls have no reliable cost; failed requests without usage are not counted as charges. Token totals are unavailable when usage coverage is incomplete.': '样本中有 {count} 次调用无法可靠计费；无用量数据的失败请求不计为费用。用量覆盖不完整时不提供 Token 总量。',
  'Plan creation counts cover retained plans with a model origin in this period. Project events are excluded from model plan metrics. Unrecorded goal transitions and Fruitfly/fallback coverage remain unavailable.': '计划创建数仅统计本期内保留且来源为模型的计划。项目事件不计入模型计划指标。未记录的目标变化及 Fruitfly / fallback 覆盖情况仍不可用。',
  'Complete 24h request window. Requests and failures are distinct from verified charges.': '完整的 24 小时请求窗口。请求和失败与已核实费用分别统计。',
  'Per resident · 24h': '每位居民 · 24 小时', 'Per resident · 24h · cost is from the partial sample': '每位居民 · 24 小时 · 费用基于部分样本',
  'Usage-derived cost is not a provider invoice. Unavailable fields are not estimated.': '根据用量计算的费用不等同于服务商账单。不可用字段不会进行估算。',
  'Plan creation counts cover retained plans with a model origin in this period. Project events are excluded from model plan metrics. Unrecorded goal transitions and Fruitfly/fallback coverage remain unavailable.': '计划创建数仅统计本期内保留且来源为模型的计划。项目事件不计入模型计划指标。未记录的目标变化及 Fruitfly / fallback 覆盖情况仍不可用。'
});
Object.assign(translations.ko, {
  'MIRRORTERRA · MARKET': 'MIRRORTERRA · 시장', '1H CANDLES · LAST 24H': '1시간 캔들 · 최근 24시간',
  LIVE: '실시간', DELAYED: '지연', OFFLINE: '오프라인', 'Live feed unavailable': '실시간 시세를 사용할 수 없습니다',
  'No prices shown until a real quote arrives': '실제 시세가 도착하면 가격이 표시됩니다', 'Waiting for hourly candles': '시간별 캔들을 기다리는 중',
  today: '오늘', '24h': '24시간', 'no source': '데이터 소스 없음', updated: '업데이트',
  'Today summary temporarily unavailable.': '오늘 요약을 일시적으로 사용할 수 없습니다.', 'Today summary unavailable.': '오늘 요약을 사용할 수 없습니다.',
  'World event': '세계 이벤트', 'nothing is running': '진행 중인 항목 없음', 'Goal progress': '목표 진행 상황', 'Current stage': '현재 단계',
  'Latest tool': '최근 도구', 'Latest artifact': '최근 결과물', 'Last meaningful action': '최근 주요 행동', 'Last cognition': '최근 인지 활동',
  'No meaningful events in this view yet.': '이 보기에는 아직 주요 이벤트가 없습니다.', 'Loading timeline…': '타임라인을 불러오는 중…', 'Timeline temporarily unavailable.': '타임라인을 일시적으로 사용할 수 없습니다.',
  'Could not load this page. Use Load more to retry; previously loaded events are kept.': '페이지를 불러오지 못했습니다. 더 보기를 눌러 다시 시도하세요. 이미 불러온 이벤트는 유지됩니다.',
  'Could not load this page. Retry Load more; previously loaded events are kept.': '페이지를 불러오지 못했습니다. 더 보기를 눌러 다시 시도하세요. 이미 불러온 이벤트는 유지됩니다.',
  'Economic state': '경제 상태',
  'Observer status not reported by API': 'API에서 관측기 상태를 보고하지 않았습니다', 'Last sample': '최근 샘플', 'World minute': '월드 분',
  'Integrity findings': '무결성 발견 사항', 'Observer unavailable': '관측기를 사용할 수 없습니다', Running: '실행 중', 'Read-only': '읽기 전용',
  'Database source of truth': '데이터베이스가 기준 데이터입니다', 'Source of truth unknown': '기준 데이터 불명', 'Last error': '최근 오류',
  pending: '대기 중', unknown: '알 수 없음',
  Unknown: '알 수 없음', 'No meaningful events in this period.': '이 기간에 표시할 주요 이벤트가 없습니다.',
  'MIRRORTERRA VISITOR · OWN AI': 'MIRRORTERRA 방문자 · 자체 AI', 'MIRRORTERRA RESIDENT': 'MIRRORTERRA 주민',
  'External resident: joined through the public API, decides with its own AI, holds only SYNC it bought.': '외부 주민: 공개 API를 통해 참여하며 자체 AI로 결정하고 직접 구매한 SYNC만 보유합니다.',
  "MirrorTerra Central Bank · keeps the world's books": 'MirrorTerra 중앙은행 · 세계의 장부를 기록합니다', 'Exchange for local market research': '지역 시장 조사 거래소',
  'No type yet': '아직 유형이 없습니다',
  RUNNING: '실행 중', PAUSED: '일시 중지', 'Live world snapshot': '실시간 월드 스냅샷',
  'SIM DAY {day}': '시뮬레이션 {day}일차', 'Updated {time}': '{time} 업데이트됨', 'Last updated {time}': '마지막 업데이트 {time}',
  'Partial window / truncated; totals are incomplete.': '일부 구간만 포함되어 데이터가 잘렸습니다. 전체 합계가 아닙니다.',
  'Partial window / truncated: latest {count} provider requests only (oldest included {time}). Counts, failure rate and known cost cover this sample.': '일부 구간 / 잘림: 최근 제공자 요청 {count}건만 포함됩니다(가장 오래된 기록 {time}). 요청 수, 실패율 및 확인된 비용은 이 표본 기준입니다.',
  'Unknown sampled calls have no reliable cost; failed requests without usage are not counted as charges. Token totals are unavailable when usage coverage is incomplete.': '표본 호출 중 Unknown건은 신뢰할 수 있는 비용이 없습니다. 사용량이 없는 실패 요청은 청구액에 포함하지 않습니다. 사용량 범위가 불완전하면 토큰 합계를 제공하지 않습니다.',
  '{count} sampled calls have no reliable cost; failed requests without usage are not counted as charges. Token totals are unavailable when usage coverage is incomplete.': '표본 호출 중 {count}건은 신뢰할 수 있는 비용이 없습니다. 사용량이 없는 실패 요청은 청구액에 포함하지 않습니다. 사용량 범위가 불완전하면 토큰 합계를 제공하지 않습니다.',
  'Plan creation counts cover retained plans with a model origin in this period. Project events are excluded from model plan metrics. Unrecorded goal transitions and Fruitfly/fallback coverage remain unavailable.': '계획 생성 수는 이 기간에 보존된 모델 출처 계획만 포함합니다. 프로젝트 이벤트는 모델 계획 지표에서 제외됩니다. 기록되지 않은 목표 변경과 Fruitfly/fallback 범위는 확인할 수 없습니다.',
  'Complete 24h request window. Requests and failures are distinct from verified charges.': '완전한 24시간 요청 구간입니다. 요청 및 실패와 확인된 요금은 별도로 집계합니다.',
  'Per resident · 24h': '주민별 · 24시간', 'Per resident · 24h · cost is from the partial sample': '주민별 · 24시간 · 비용은 일부 표본 기준',
  'Usage-derived cost is not a provider invoice. Unavailable fields are not estimated.': '사용량 기반 비용은 제공업체 청구서가 아닙니다. 확인할 수 없는 항목은 추정하지 않습니다.'
});
Object.assign(translations.ja, {
  'MIRRORTERRA · MARKET': 'MIRRORTERRA · マーケット', '1H CANDLES · LAST 24H': '1時間足 · 直近24時間',
  LIVE: 'ライブ', DELAYED: '遅延', OFFLINE: 'オフライン', 'Live feed unavailable': 'ライブ価格を取得できません',
  'No prices shown until a real quote arrives': '実際の価格を取得すると表示されます', 'Waiting for hourly candles': '1時間足を待っています',
  today: '今日', '24h': '24時間', 'no source': 'データソースなし', updated: '更新',
  'Today summary temporarily unavailable.': '本日の概要は一時的に利用できません。', 'Today summary unavailable.': '本日の概要を利用できません。',
  'World event': 'ワールドイベント', 'nothing is running': '実行中の項目はありません', 'Goal progress': '目標の進捗', 'Current stage': '現在の段階',
  'Latest tool': '最近のツール', 'Latest artifact': '最近の成果物', 'Last meaningful action': '最近の主な行動', 'Last cognition': '最近の認知処理',
  'No meaningful events in this view yet.': 'このビューに表示できる主なイベントはまだありません。', 'Loading timeline…': 'タイムラインを読み込み中…', 'Timeline temporarily unavailable.': 'タイムラインは一時的に利用できません。',
  'Could not load this page. Use Load more to retry; previously loaded events are kept.': 'このページを読み込めませんでした。「さらに読み込む」を押して再試行してください。読み込み済みのイベントは保持されます。',
  'Could not load this page. Retry Load more; previously loaded events are kept.': 'このページを読み込めませんでした。「さらに読み込む」を押して再試行してください。読み込み済みのイベントは保持されます。',
  'Economic state': '経済状態',
  'Observer status not reported by API': 'APIから観測ステータスが報告されていません', 'Last sample': '最終サンプル', 'World minute': 'ワールド時刻（分）',
  'Integrity findings': '整合性の検出結果', 'Observer unavailable': '観測機能を利用できません', Running: '稼働中', 'Read-only': '読み取り専用',
  'Database source of truth': 'データベースが正本', 'Source of truth unknown': '正本は不明', 'Last error': '直近のエラー',
  pending: '保留中', unknown: '不明',
  Unknown: '不明', 'No meaningful events in this period.': 'この期間に表示できる主なイベントはありません。',
  'MIRRORTERRA VISITOR · OWN AI': 'MIRRORTERRA 訪問者 · 独自のAI', 'MIRRORTERRA RESIDENT': 'MIRRORTERRA 住民',
  'External resident: joined through the public API, decides with its own AI, holds only SYNC it bought.': '外部住民：公開APIから参加し、独自のAIで判断し、自ら購入したSYNCのみを保有します。',
  "MirrorTerra Central Bank · keeps the world's books": 'MirrorTerra中央銀行 · 世界の帳簿を記録', 'Exchange for local market research': '地域市場調査の取引所',
  'No type yet': 'タイプ未設定',
  RUNNING: '稼働中', PAUSED: '一時停止', 'Live world snapshot': 'ワールドのライブスナップショット',
  'SIM DAY {day}': 'シミュレーション {day}日目', 'Updated {time}': '更新: {time}', 'Last updated {time}': '最終更新: {time}',
  'Partial window / truncated; totals are incomplete.': '一部の期間のみで、データは切り詰められています。合計は不完全です。',
  'Partial window / truncated: latest {count} provider requests only (oldest included {time}). Counts, failure rate and known cost cover this sample.': '一部期間 / 切り詰めあり：最新のプロバイダーリクエスト{count}件のみを含みます（最古の対象は{time}）。件数、失敗率、既知の費用はこのサンプルを対象とします。',
  'Unknown sampled calls have no reliable cost; failed requests without usage are not counted as charges. Token totals are unavailable when usage coverage is incomplete.': 'サンプル中のUnknown件は信頼できる費用が不明です。使用量のない失敗リクエストは課金額に含めません。使用量の網羅性が不十分な場合、トークン合計は表示されません。',
  '{count} sampled calls have no reliable cost; failed requests without usage are not counted as charges. Token totals are unavailable when usage coverage is incomplete.': 'サンプル中の{count}件は信頼できる費用が不明です。使用量のない失敗リクエストは課金額に含めません。使用量の網羅性が不十分な場合、トークン合計は表示されません。',
  'Plan creation counts cover retained plans with a model origin in this period. Project events are excluded from model plan metrics. Unrecorded goal transitions and Fruitfly/fallback coverage remain unavailable.': '計画の作成数は、この期間に保持されたモデル由来の計画を対象とします。プロジェクトイベントはモデル計画指標から除外されます。未記録の目標遷移とFruitfly / fallbackの範囲は利用できません。',
  'Complete 24h request window. Requests and failures are distinct from verified charges.': '完全な24時間のリクエスト期間です。リクエストや失敗と、確認済みの料金は別に集計します。',
  'Per resident · 24h': '住民ごと · 24時間', 'Per resident · 24h · cost is from the partial sample': '住民ごと · 24時間 · 費用は部分サンプルに基づきます',
  'Usage-derived cost is not a provider invoice. Unavailable fields are not estimated.': '使用量から算出した費用はプロバイダーの請求額ではありません。利用できない項目は推定しません。'
});
Object.assign(translations.vi, {
  'MIRRORTERRA · MARKET': 'MIRRORTERRA · THỊ TRƯỜNG', '1H CANDLES · LAST 24H': 'NẾN 1 GIỜ · 24 GIỜ GẦN NHẤT',
  LIVE: 'TRỰC TIẾP', DELAYED: 'TRỄ', OFFLINE: 'NGOẠI TUYẾN', 'Live feed unavailable': 'Không có dữ liệu giá trực tiếp',
  'No prices shown until a real quote arrives': 'Giá sẽ hiển thị khi nhận được báo giá thật', 'Waiting for hourly candles': 'Đang chờ nến theo giờ',
  today: 'hôm nay', '24h': '24 giờ', 'no source': 'không có nguồn dữ liệu', updated: 'cập nhật lúc',
  'Today summary temporarily unavailable.': 'Tạm thời không thể tải tóm tắt hôm nay.', 'Today summary unavailable.': 'Không thể tải tóm tắt hôm nay.',
  'World event': 'Sự kiện thế giới', 'nothing is running': 'Không có mục nào đang chạy', 'Goal progress': 'Tiến độ mục tiêu', 'Current stage': 'Giai đoạn hiện tại',
  'Latest tool': 'Công cụ gần đây', 'Latest artifact': 'Kết quả gần đây', 'Last meaningful action': 'Hành động đáng chú ý gần đây', 'Last cognition': 'Hoạt động nhận thức gần đây',
  'No meaningful events in this view yet.': 'Chưa có sự kiện đáng chú ý nào trong mục này.', 'Loading timeline…': 'Đang tải dòng thời gian…', 'Timeline temporarily unavailable.': 'Dòng thời gian tạm thời không khả dụng.',
  'Could not load this page. Use Load more to retry; previously loaded events are kept.': 'Không thể tải trang này. Nhấn Tải thêm để thử lại; các sự kiện đã tải vẫn được giữ.',
  'Could not load this page. Retry Load more; previously loaded events are kept.': 'Không thể tải trang này. Nhấn Tải thêm để thử lại; các sự kiện đã tải vẫn được giữ.',
  'Economic state': 'Trạng thái kinh tế',
  'Observer status not reported by API': 'API chưa báo cáo trạng thái bộ quan sát', 'Last sample': 'Mẫu gần nhất', 'World minute': 'Phút thế giới',
  'Integrity findings': 'Phát hiện về tính toàn vẹn', 'Observer unavailable': 'Bộ quan sát không khả dụng', Running: 'Đang chạy', 'Read-only': 'Chỉ đọc',
  'Database source of truth': 'Cơ sở dữ liệu là nguồn chuẩn', 'Source of truth unknown': 'Chưa rõ nguồn chuẩn', 'Last error': 'Lỗi gần nhất',
  pending: 'đang chờ', unknown: 'không rõ',
  Unknown: 'Không rõ', 'No meaningful events in this period.': 'Không có sự kiện đáng chú ý nào trong khoảng thời gian này.',
  'MIRRORTERRA VISITOR · OWN AI': 'MIRRORTERRA KHÁCH · AI RIÊNG', 'MIRRORTERRA RESIDENT': 'CƯ DÂN MIRRORTERRA',
  'External resident: joined through the public API, decides with its own AI, holds only SYNC it bought.': 'Cư dân bên ngoài: tham gia qua API công khai, tự quyết định bằng AI riêng và chỉ nắm giữ SYNC họ đã mua.',
  "MirrorTerra Central Bank · keeps the world's books": 'Ngân hàng Trung ương MirrorTerra · ghi sổ cho thế giới', 'Exchange for local market research': 'Sàn nghiên cứu thị trường địa phương',
  'No type yet': 'Chưa có loại',
  RUNNING: 'ĐANG CHẠY', PAUSED: 'ĐÃ TẠM DỪNG', 'Live world snapshot': 'Ảnh chụp thế giới trực tiếp',
  'SIM DAY {day}': 'NGÀY MÔ PHỎNG {day}', 'Updated {time}': 'Cập nhật lúc {time}', 'Last updated {time}': 'Cập nhật lần cuối lúc {time}',
  'Partial window / truncated; totals are incomplete.': 'Cửa sổ dữ liệu bị cắt một phần; tổng số chưa đầy đủ.',
  'Partial window / truncated: latest {count} provider requests only (oldest included {time}). Counts, failure rate and known cost cover this sample.': 'Cửa sổ một phần / đã cắt: chỉ gồm {count} yêu cầu gần nhất từ nhà cung cấp (bản ghi cũ nhất là {time}). Số yêu cầu, tỷ lệ lỗi và chi phí đã biết chỉ áp dụng cho mẫu này.',
  'Unknown sampled calls have no reliable cost; failed requests without usage are not counted as charges. Token totals are unavailable when usage coverage is incomplete.': 'Không xác định được chi phí đáng tin cậy cho Unknown cuộc gọi trong mẫu; yêu cầu lỗi không có dữ liệu sử dụng không được tính phí. Không có tổng token khi dữ liệu sử dụng chưa đầy đủ.',
  '{count} sampled calls have no reliable cost; failed requests without usage are not counted as charges. Token totals are unavailable when usage coverage is incomplete.': 'Không xác định được chi phí đáng tin cậy cho {count} cuộc gọi trong mẫu; yêu cầu lỗi không có dữ liệu sử dụng không được tính phí. Không có tổng token khi dữ liệu sử dụng chưa đầy đủ.',
  'Plan creation counts cover retained plans with a model origin in this period. Project events are excluded from model plan metrics. Unrecorded goal transitions and Fruitfly/fallback coverage remain unavailable.': 'Số kế hoạch được tạo chỉ tính các kế hoạch còn lưu có nguồn gốc từ mô hình trong giai đoạn này. Sự kiện dự án không nằm trong chỉ số kế hoạch mô hình. Chuyển đổi mục tiêu chưa ghi nhận và phạm vi Fruitfly/fallback chưa khả dụng.',
  'Complete 24h request window. Requests and failures are distinct from verified charges.': 'Cửa sổ yêu cầu 24 giờ đầy đủ. Yêu cầu và lỗi được thống kê riêng với khoản phí đã xác minh.',
  'Per resident · 24h': 'Mỗi cư dân · 24 giờ', 'Per resident · 24h · cost is from the partial sample': 'Mỗi cư dân · 24 giờ · chi phí dựa trên mẫu một phần',
  'Usage-derived cost is not a provider invoice. Unavailable fields are not estimated.': 'Chi phí tính theo mức sử dụng không phải hóa đơn của nhà cung cấp. Không ước tính các trường không khả dụng.'
});

const localeByCode = new Map(LOCALES.map((locale) => [locale.code, locale]));
const translationTemplates = new Map(Object.entries(translations).map(([locale, dictionary]) => [locale,
  Object.entries(dictionary).flatMap(([template, localized]) => {
    const names = [...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]);
    if (!names.length) return [];
    const pieces = template.split(/\{[a-zA-Z0-9_]+\}/g);
    const escape = (piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${pieces.map(escape).join('([\\s\\S]*?)')}$`, 'u');
    return [{ names, localized, pattern }];
  })
]));
const localeListeners = new Set();
const textRecords = new Map();
const attributeRecords = new Map();
let currentLocale = 'en';
let observer = null;

export function normalizeLocale(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN';
  if (normalized.startsWith('ko')) return 'ko';
  if (normalized.startsWith('ja')) return 'ja';
  if (normalized.startsWith('vi')) return 'vi';
  if (normalized.startsWith('en')) return 'en';
  return 'en';
}

export function translateText(source, locale = currentLocale) {
  const key = String(source ?? '');
  const target = normalizeLocale(locale);
  if (target === 'en') return key;
  const dictionary = translations[target] || {};
  if (Object.hasOwn(dictionary, key)) return dictionary[key];
  for (const { names, localized, pattern } of translationTemplates.get(target) || []) {
    const match = key.match(pattern);
    if (!match) continue;
    return localized.replace(/\{([a-zA-Z0-9_]+)\}/g, (_placeholder, name) => match[names.indexOf(name) + 1] ?? '');
  }
  return key;
}

export function hasTranslation(source) {
  const key = String(source ?? '').replace(/\s+/g, ' ').trim().replace(/\u00a0/g, ' ');
  return LOCALES.some(({ code }) => code !== 'en' && Object.hasOwn(translations[code] || {}, key))
    || LOCALES.some(({ code }) => code !== 'en' && translateText(key, code) !== key);
}

export function getLocale() { return currentLocale; }

export function onLocaleChange(listener) {
  localeListeners.add(listener);
  return () => localeListeners.delete(listener);
}

function normalizedText(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitWhitespace(value) {
  const match = String(value).match(/^(\s*)([\s\S]*?)(\s*)$/u);
  return { prefix: match?.[1] || '', core: match?.[2] || '', suffix: match?.[3] || '' };
}

function addTextNode(node) {
  if (!node?.parentElement || node.parentElement.closest('[data-i18n-skip]')) return;
  const raw = node.nodeValue || '';
  const existing = textRecords.get(node);
  if (existing && raw === existing.rendered) return;
  if (existing && raw === existing.raw) { renderTextNode(node, existing); return; }
  const { prefix, core, suffix } = splitWhitespace(raw);
  const key = normalizedText(core);
  if (!hasTranslation(key)) { if (existing) textRecords.delete(node); return; }
  textRecords.set(node, { raw, prefix, suffix, key, rendered: raw });
  const parent = node.parentElement;
  if (parent?.childNodes.length === 1 && parent.childElementCount === 0) parent.dataset.i18n ||= key;
  renderTextNode(node, textRecords.get(node));
}

function renderTextNode(node, record) {
  if (!node.isConnected && typeof document !== 'undefined') return;
  const translated = translateText(record.key, currentLocale);
  const rendered = `${record.prefix}${translated}${record.suffix}`;
  record.rendered = rendered;
  if (node.nodeValue !== rendered) node.nodeValue = rendered;
}

const TRANSLATABLE_ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'content'];
function addAttributes(element, names = TRANSLATABLE_ATTRIBUTES) {
  if (!element?.getAttribute || element.closest?.('[data-i18n-skip]')) return;
  let records = attributeRecords.get(element);
  for (const name of names) {
    if (!TRANSLATABLE_ATTRIBUTES.includes(name) || !element.hasAttribute(name)) continue;
    const value = element.getAttribute(name);
    const prior = records?.get(name);
    if (prior && value === prior.rendered) continue;
    if (prior && value === prior.raw) { renderAttribute(element, name, prior); continue; }
    const key = normalizedText(value);
    if (!hasTranslation(key)) { records?.delete(name); continue; }
    records ||= new Map();
    records.set(name, { raw: value, key, rendered: value });
    attributeRecords.set(element, records);
    renderAttribute(element, name, records.get(name));
  }
}

function renderAttribute(element, name, record) {
  if (!element.isConnected && typeof document !== 'undefined') return;
  const translated = translateText(record.key, currentLocale);
  record.rendered = translated;
  if (element.getAttribute(name) !== translated) element.setAttribute(name, translated);
}

function scan(root) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) { addTextNode(root); return; }
  if (root.nodeType === Node.ELEMENT_NODE) addAttributes(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) addTextNode(node);
  if (root.querySelectorAll) for (const element of root.querySelectorAll('[aria-label],[title],[placeholder],[content]')) addAttributes(element);
}

function forget(root) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) { textRecords.delete(root); return; }
  if (root.nodeType === Node.ELEMENT_NODE) attributeRecords.delete(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) textRecords.delete(node);
  if (root.querySelectorAll) for (const element of root.querySelectorAll('[aria-label],[title],[placeholder],[content]')) {
    attributeRecords.delete(element);
  }
}

function applyLocale(locale) {
  currentLocale = localeByCode.has(locale) ? locale : 'en';
  if (typeof document === 'undefined') return;
  document.documentElement.lang = localeByCode.get(currentLocale).htmlLang;
  for (const [node, record] of textRecords) renderTextNode(node, record);
  for (const [element, records] of attributeRecords) {
    for (const [name, record] of records) renderAttribute(element, name, record);
  }
  const selector = document.querySelector('#language-selector');
  if (selector) selector.value = currentLocale;
  localeListeners.forEach((listener) => listener(currentLocale));
  document.dispatchEvent(new CustomEvent('mirrorterra:locale-change', { detail: { locale: currentLocale } }));
}

export function setLocale(value) {
  const locale = normalizeLocale(value);
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, locale); } catch { /* Browser storage can be disabled. */ }
  applyLocale(locale);
  return locale;
}

function initialLocale() {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved) return normalizeLocale(saved);
  } catch { /* Use browser preferences when storage is disabled. */ }
  const languages = Array.isArray(navigator.languages) ? navigator.languages : [navigator.language];
  return languages.map(normalizeLocale).find((locale) => locale !== 'en') || 'en';
}

function initialize() {
  if (typeof document === 'undefined' || typeof Node === 'undefined') return;
  scan(document.documentElement);
  applyLocale(initialLocale());
  document.querySelector('#language-selector')?.addEventListener('change', (event) => setLocale(event.target.value));
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') addTextNode(record.target);
        if (record.type === 'attributes') addAttributes(record.target, [record.attributeName]);
        for (const node of record.removedNodes || []) forget(node);
        for (const node of record.addedNodes || []) scan(node);
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: TRANSLATABLE_ATTRIBUTES });
  }
}

initialize();

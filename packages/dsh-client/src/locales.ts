/**
 * 这份插件的用户可见文案，走 DSH 的 locale 字典。
 *
 * `verify-client-ui-i18n`（宿主仓库的检查，本插件以同一标准自检）只允许字典
 * 文件持有成品文案：界面代码一律通过 `t` 读这里的键。zh 与 en 都必须齐——
 * 注册时两个语言一起交给 `ctx.locale.register`，缺一边就注册不上。
 *
 * 占位符用 `{name}` 形式，调用侧以 `t(key, { name })` 传值；两种语言必须
 * 用同样一组占位符，否则切语言会渲染出残句。
 *
 * `panel.*` 是面板本体的文案（panel.tsx / verdict.ts 读）。这是在 main 最新
 * 的 panel.tsx 上重做的迁移：连接状态模型（row.connection：connected /
 * reachable / checking / disconnected）与 ssh 自动部署的界面文案都是 main
 * 新增的串，各自起了新键；旧迁移里「添加主机帮助块」的键（panel.help.*）
 * 没有跟过来——那一块界面已被 main 的改版整块移除（测试也钉住它不在），
 * 字典不留无主键。带行内元素的句子（ssh 说明、访问方式标签）沿用帮助块的
 * `{…}` 记号约定：记号内容随语言走，`richSegments` 拆开包回行内元素。
 *
 * 其中还有一小批「运行时层」的键（panel.gateway.* / panel.tailscale.* 的
 * 报错、panel.ssh 的 HTTP 错误模板）：它们产自入口接线（client/index.ts）
 * 与 ssh-deploy.ts 的端口结果，不经过 JSX，`verify-client-ui-i18n` 的
 * 属性赋值规则只扫 .tsx、看不见它们——双语化靠调用侧把 `t` 递进端口，
 * locale 服务缺席时由 `fallbackT` 读本文件回落（tests/runtime-locale.spec.ts
 * 钉住这批键与回落行为）。
 */

/** 这个插件在 locale 注册表里的命名空间。 */
export const NAMESPACE = 'threadharborClient'

/** 中文词典（源语言，键的出处）。 */
export const zh = {
  /** 侧栏行名：主机列表面板。 */
  'panel.label': '各主机',
  /** 切换进度条的三个阶段；`{target}` 是新会话的 agent 名。 */
  'progress.preparing': '正在准备打开新会话 · {target}',
  'progress.loading': '正在读新会话的历史 · {target}',
  'progress.ready': '新会话已就绪，正在切换 · {target}',
  /** 交接卡：被切走的回合显示的中性行。 */
  'handover.title': '已切换到 {target}，对话已移到新会话',
  'handover.open': '打开新会话',
  /** 手机配对 section：侧栏行名与面板三种状态。 */
  'pairing.label': '手机配对',
  'pairing.loading': '正在获取配对网址…',
  'pairing.ready.title': '用手机扫码打开',
  'pairing.qr.alt': '手机配对二维码',
  'pairing.url.hint': '扫码不便时，把这个网址发到手机上打开：',
  'pairing.guidance.originTitle': '还差一步配置：手机端访问地址',
  'pairing.guidance.origin': '这台 DSH 还没有配置 mobileOrigin。请按文档在 DSH 配置里给 threadharbor-mobile-entry 设置 mobileOrigin 字段（手机端根网址，如 https://mac1.example.ts.net），保存并重启 DSH 后刷新这个页面。',
  'pairing.guidance.unreachableTitle': '拿不到配对网址',
  'pairing.guidance.unreachable': '没能从这台主机取回配对网址。请确认这个页面是从 DSH 服务所在的机器打开的，然后刷新页面重试。',
  'pairing.guidance.detail': '原因：{detail}',

  // —— 面板本体（panel.tsx）直接渲染在 JSX 里的成品文案 ——

  /** 页面标题与小节标题。 */
  'panel.title.hosts': '主机',
  'panel.title.addHost': '添加新主机',
  'panel.title.management': '主机管理',
  'panel.title.selfAgents': '本机 agent',
  'panel.title.connectionCare': '连接由谁照看',
  'panel.title.notes': '说明',
  /** 按钮。 */
  'panel.button.probe': '探测',
  'panel.button.confirm': '确定',
  'panel.button.save': '保存',
  'panel.button.cancel': '取消',
  'panel.button.back': '‹ 返回',
  'panel.button.backToList': '返回列表',
  'panel.button.deleteRegistration': '删除登记',
  'panel.button.confirmRemove': '确定删除',
  'panel.button.refresh': '刷新',
  'panel.button.pickFromTailscale': '从 Tailscale 选',
  'panel.button.settings': '设置',
  'panel.button.reachTry': '检测可达',
  'panel.button.copyLink': '复制链接',
  /**
   * 状态词：列表行圆点与详情页状态行共用。main 的状态模型是
   * row.connection（connected / reachable / checking / disconnected），
   * 「在线」只留给心跳报数的事实行与 Tailscale 节点徽标。
   */
  'panel.status.self': '本机',
  'panel.status.online': '在线',
  'panel.status.offline': '未连接',
  'panel.status.connected': '已连接',
  'panel.status.reachable': '可达',
  'panel.status.checking': '检测中',
  'panel.status.reachableUnsynced': '可达未同步',
  /** 探测的状态行；`{message}` 是接线层报出的错误原文。 */
  'panel.probe.idle': '未探测',
  'panel.probe.running': '探测中……（最多等一分钟）',
  'panel.probe.error': '探测出错：{message}',
  /** 打不开会话网关时接线层给的错误原文（agent 列表与探测结论共用）。 */
  'panel.gateway.missing': '主机服务缺失：{missing}',
  'panel.gateway.notReady': '主机服务未就绪：{error}',
  /** 结论旁折叠起来的建议小节。 */
  'panel.verdict.advice': '建议',
  /** 四种结论的措辞与建议（describeVerdict）；`{ms}` 是耗时毫秒数。 */
  'panel.verdict.ok': '正常',
  'panel.verdict.slow': '偏慢',
  'panel.verdict.hung': '卡住',
  'panel.verdict.unreachable': '连不上',
  'panel.verdict.hungStartedDetail': '{ms} ms 内开了工但没有完成',
  'panel.verdict.hungSilentDetail': '{ms} ms 内无回应',
  'panel.verdict.okAdvice': '有回应，速度正常，不用处理。',
  'panel.verdict.slowAdvice': '回来了但超过正常阈值——建议再探测一次，慢不代表卡。',
  'panel.verdict.hungStartedAdvice': 'agent 领了这轮对话但一直没交回——多半卡在它那一侧。去主机上看这个 agent 的进程和日志；连接如果断了，主机会在下一次对话时自动重连。',
  'panel.verdict.hungSilentAdvice': '到点没有动静——agent 多半没在工作。去主机上查看这个 agent 的进程和日志；连接如果断了，主机会在下一次对话时自动重连。',
  'panel.verdict.unreachableAdvice': '先检查主机的 agent 地址和凭证是否正确；这不是等待或重连能解决的问题。',
  /** 表单字段名与占位符；示例值也归字典（检查器把带字母的字面量当成品文案）。 */
  'panel.form.fieldName': '名称',
  'panel.form.fieldNamePlaceholder': '如：mac-mini',
  'panel.form.fieldStatus': '状态',
  'panel.form.fieldIp': 'IP',
  'panel.form.ipPlaceholder': '100.101.1.7，可带端口：100.101.1.7:3081',
  'panel.form.fieldTitle': '显示名',
  /** 存储姿态行（storagePostureLine）；`{detail}` 是存储层报出的原始原因。 */
  'panel.posture.host': '登记与本机名称保存在这台机器上：换浏览器、换标签页、清缓存都不会丢。',
  'panel.posture.loading': '正在从这台机器读取已保存的登记……',
  'panel.posture.memoryRemotePage': '这个页面由远程机器提供：登记与本机名称只保存在本页内存里，关闭页面就没有了。',
  'panel.posture.memoryNoChannel': '这台机器没有提供设置存储通道（remote.settings）：登记与本机名称只保存在本页内存里，关闭页面就没有了。',
  'panel.posture.degraded': '这台机器上的存储出了问题：{detail}。名单还在本页里；真正存进去之前，换浏览器或清缓存会丢。',
  /** 心跳的久暂措辞（heartbeatWord）；`{n}` 是间隔数值。 */
  'panel.time.justNow': '刚刚',
  'panel.time.secondsAgo': '{n} 秒前',
  'panel.time.minutesAgo': '{n} 分钟前',
  'panel.time.hoursAgo': '{n} 小时前',
  /** 详情页的事实区；`{age}` 是心跳措辞（heartbeatWord）的产物。 */
  'panel.facts.selfLine': '这就是本机：这里显示和编辑的是这个标签页自己声明的身份。',
  'panel.facts.status': '状态：{status}',
  'panel.facts.heartbeat': ' · 最近心跳 {age}',
  'panel.facts.offlineNote': '频道上没有这台主机的报数',
  /** 离线注脚按 DOM 拆成三段：前句、在线名称冒头、句号。 */
  'panel.facts.offlineIdsPrefix': '；现在在线的名称：',
  'panel.facts.offlineEnd': '。',
  /** 在线名称列表的枚举分隔符（join 的胶水，不是句子）；网关缺失清单同用。 */
  'panel.facts.onlineIdsSeparator': '、',
  'panel.facts.match': '（与填写一致）',
  'panel.facts.idMismatch': '（与填写的不一样；两边都保留，把名称改成它，两边就对上了）',
  'panel.facts.reportedTitle': '主机自报名称：{name}',
  /** 删除登记的确认句。 */
  'panel.registry.removeNote': '只从这台机器的登记列表里移除，不动远端那台机器。确定？',
  /** 详情页登记区：打开含 token 页面的链接。 */
  'panel.registry.launchLink': '连接（打开含 token 的页面）',
  /** 详情页的可达性复查；`{ms}` 是超时毫秒数。 */
  'panel.reach.probeTimeout': '检测超时（{ms} ms）',
  /** 本机 agent 区。 */
  'panel.agents.loading': '正在读取本机 agent……',
  'panel.agents.failed': '读取失败：{message}',
  'panel.agents.empty': '这台主机没有列出任何 acp agent——可能没有配置预设，或模型目录读取失败；点"刷新"再试。',
  /** Tailscale 地址选择器；`{ip}`/`{status}` 拼每台 peer 的行。 */
  'panel.tailscale.pickTitle': '从 Tailscale 选一台',
  'panel.tailscale.loading': '正在读取清单……',
  'panel.tailscale.empty': '清单是空的——只有本机，或还没登录 Tailscale。',
  'panel.tailscale.collapse': '收起',
  'panel.tailscale.peerMeta': '{ip} · {status}',
  /** Tailscale 选择器读不到清单时端口给的错误行；`{error}` 是通道的拒绝原文。 */
  'panel.tailscale.noChannel': '这台机器没有提供设置通道（remote.settings）',
  'panel.tailscale.badList': '清单读出来是坏的，没法解析',
  'panel.tailscale.refreshDenied': '刷新请求被拒：{error}',
  /** 面板上直接渲染的说明。 */
  'panel.notes.selfHeal': '连接由主机自己照看：发现断了会自动丢弃并在下一次对话时自动重连，无需在这里操作。',
  'panel.notes.onlineMeaning': '「在线」= 这台机器的页面在同一个浏览器的同源标签页里开着并按心跳报数；关闭或崩溃的页面过了静默窗口会自动转为未列出。',
  'panel.notes.otherSource': '另一台机器（另一个源）的页面不在这个频道里；它的行以「未连接」出现，靠的是登记。',
  /** 列表页的空态。 */
  'panel.list.empty': '还没有主机。点「添加新主机」登记第一台。',
  /**
   * SSH 自动部署（main 新增的界面）。intro 用 `{当前这台机器}` 标 strong 段；
   * introLoopback 等键保留给门禁与历史 rich 文案检查。
   */
  'panel.ssh.title': 'SSH 自动部署',
  'panel.ssh.manualEntry': '手动登记',
  'panel.ssh.intro': '对方的 DSH 只听 127.0.0.1。任意一台已安装 ThreadHarbor 的主机都可以 SSH 到另一台，读取对方是否已装插件和带 token 的地址，再在本机打开 SSH 隧道访问。私钥路径指{当前这台机器}上的绝对路径；粘贴私钥或密码只发给本机 DSH 进程，不会写入日志。',
  'panel.ssh.introLoopback': '非 loopback 绑定不会使用 0.0.0.0，仍依赖 DSH 的 {?token=} 换 cookie。',
  'panel.ssh.accessMode': '访问方式',
  'panel.ssh.accessHostIp': '主机 IP（默认：远端自动检测 IP 并绑定，登记 {http://<主机IP>:<端口>}，不建 SSH 隧道）',
  'panel.ssh.accessTunnel': '本机 SSH 隧道（远端 127.0.0.1 + 本地端口转发）',
  'panel.ssh.bindHostLabel': '绑定地址（可选，留空则远端自动检测 Tailscale / 网卡 IP）',
  'panel.ssh.bindHostPlaceholder': '192.168.x.x 或 100.x.x.x',
  'panel.ssh.trustedHostLabel': '--trusted-host（可选，MagicDNS 名）',
  'panel.ssh.trustedHostPlaceholder': 'mybox.tail1234.ts.net',
  'panel.ssh.targetLabel': 'SSH 主机',
  'panel.ssh.targetPlaceholder': '192.168.1.10',
  'panel.ssh.portLabel': '端口',
  'panel.ssh.userLabel': '用户',
  'panel.ssh.userPlaceholder': 'deploy',
  'panel.ssh.proxyJumpLabel': 'ProxyJump（可选）',
  'panel.ssh.authModeLabel': '认证方式',
  'panel.ssh.authIdentityFile': '本机私钥路径',
  'panel.ssh.authIdentityPem': '粘贴私钥 PEM',
  'panel.ssh.authPassword': '密码（需本机安装 sshpass）',
  'panel.ssh.identityFileLabel': '私钥路径（Web 服务主机上）',
  'panel.ssh.identityFilePlaceholder': '/home/me/.ssh/id_ed25519',
  'panel.ssh.identityPemLabel': '私钥 PEM',
  'panel.ssh.passwordLabel': 'SSH 密码',
  'panel.ssh.remotePortLabel': '远端 DSH Web 端口',
  'panel.ssh.remoteAgentsLegend': '远端 Agent（ACP preset）',
  'panel.ssh.remoteAgentsNote': '勾选的 agent 会在远端 DSH 组合中启用（命令走 PATH，需目标机已安装对应二进制）；未勾选的将在部署后禁用。',
  'panel.ssh.readingPeer': '正在读取……',
  'panel.ssh.readPeer': '通过 SSH 读取对方状态',
  'panel.ssh.peerLoopback': '对方已安装插件，DSH 听在 127.0.0.1。打开页面会走本机 SSH 隧道。',
  'panel.ssh.peerNotLoopback': '对方这份记录不是回环监听。重新部署会改成只听 127.0.0.1，并由本机隧道访问。',
  'panel.ssh.peerMissing': '对方还没有 ThreadHarbor 的 peer 记录（尚未安装，或安装后还没成功启动）。可以在这里部署。',
  'panel.ssh.inspect': '检查 SSH 主机密钥',
  'panel.ssh.inspecting': '正在检查……',
  'panel.ssh.deploy': '部署 DSH 并登记',
  'panel.ssh.deploying': '正在部署……',
  'panel.ssh.pickKeyPrompt': '请核对指纹后选择要信任的那把钥匙：',
  'panel.ssh.progressFailed': '（{error}）',
  'panel.ssh.launchUrlPrompt': '打开链接即可换 cookie 上线（已写入登记）：',
  'panel.ssh.open': '打开',
  'panel.ssh.hostIdLabel': '主机标识（部署后登记用）',
  'panel.ssh.approveFingerprintFirst': '请先检查并批准 SSH 主机密钥指纹',
  'panel.ssh.hostIdRequired': '请填写主机标识',
  'panel.ssh.deployFailed': '部署失败',
  'panel.ssh.registered': '已登记 {endpoint}。点「打开」在新标签页完成 token 交换后，跨标签页频道会显示在线。',
  'panel.ssh.addFooterPrefix': '也可以在远端自动安装 DSH 与 ThreadHarbor：',
  'panel.ssh.redeploy': '重新部署 DSH',
  'panel.ssh.upgrade': '升级重装（替换远端现有版本并重启服务）',
  'panel.ssh.connectOnly': '连接（不重新部署）',
  'panel.ssh.progressLogTitle': '部署过程（逐阶段如实记录）',
  'panel.ssh.failedTitle': '部署失败：原始原因如下',
  'panel.ssh.retry': '重试部署',
  /** 详情页「使用这台主机」区块。 */
  'panel.use.title': '使用这台主机',
  'panel.use.noSsh': '尚未保存这台主机的 SSH 连接方式。填一次（只需密钥文件路径这类非秘密信息），之后就能一键连接。',
  'panel.use.fillSsh': '填写连接方式',
  'panel.use.tunnel.online': '隧道在线：本机可以打开它的页面。',
  'panel.use.tunnel.offline': '隧道未连通：本机转发端口没有响应。点「连接并打开」重建。',
  'panel.use.tunnel.checking': '正在检查隧道……',
  'panel.use.tunnel.unknown': '隧道状态未检查。远端 DSH 只听它自己的 127.0.0.1，从这台机器访问要走本机 SSH 隧道。',
  'panel.use.connect': '连接并打开',
  'panel.use.reconnect': '重新连接',
  'panel.use.connecting': '正在连接……',
  'panel.use.check': '检查隧道',
  'panel.use.checking': '正在检查……',
  'panel.use.open': '打开页面',
  'panel.use.secretHint': '这台主机的 SSH 用密码或粘贴私钥认证，出于安全不保存：请到「远程部署与插件」里重新输入后再点「连接」。',
  'panel.use.noCredential': '还没有可直接复用的 SSH 凭据（未保存连接方式，或用的是密码/粘贴私钥）。请在下方输入后连接。',
  'panel.use.failedTitle': '连接失败：原始原因如下',
  'panel.use.retry': '重试连接',
  /** 左侧主机树（阶段 L）。 */
  'panel.tree.undeployedNote': '尚未在这台主机上部署。到 设置 → 各主机 完成部署。',
  'panel.tree.fetchFailedTitle': '拉取失败：',
  'panel.tree.noSessions': '这台主机还没有拉到会话。',
  'panel.tree.newSession': '在本项目下新建会话',
  'panel.tree.noHosts': '还没有任何主机。',
  'panel.tree.selfHost': '本机',
  'panel.tree.menuTitle': '更多操作',
  'panel.tree.menuRenameWorkspace': '重命名项目',
  'panel.tree.menuDeleteWorkspace': '删除项目',
  'panel.tree.menuConfirmDelete': '确认删除',
  'panel.tree.menuRenameSession': '重命名会话',
  'panel.tree.menuArchiveSession': '归档会话',
  'panel.tree.menuPinSession': '置顶会话',
  'panel.tree.menuUnpinSession': '取消置顶',
  'panel.tree.menuForkSession': '分叉会话',
  'panel.tree.expandMore': '展开其余 {n} 个会话',
  'panel.tree.collapseSessions': '收起',
  'panel.tree.actionFailed': '操作失败：',
  'panel.sessionBar.copy': '复制',
  'panel.sessionBar.copied': '已复制',
  'panel.sessionBar.copyFailed': '复制失败：',
  'panel.tree.openFailed': '打开会话失败：本机界面服务未就绪或拒绝了这次调用。',
  /** 详情页「远程部署与插件」折叠区。 */
  'panel.deploy.expand': '远程部署与插件（展开）',
  'panel.deploy.collapse': '收起部署区',
  /** ssh-deploy HTTP 层的错误模板；`{status}` 是 HTTP 状态码。 */
  'panel.ssh.httpInvalid': '无效响应（HTTP {status}）',
  'panel.ssh.httpFailed': '请求失败（HTTP {status}）',
} satisfies Record<string, string>

/** 这份文案的全部键，也是命名空间声明进 `LocaleNamespaceMap` 的键域。 */
export type ClientLocaleKey = keyof typeof zh

/**
 * 运行时层读词典的面：入口接线与 ssh-deploy 的函数把它当参数收（面板的
 * `t` 席位、入口 `locale.bind` 的活函数，结构上都满足它）。占位符约定与
 * 宿主 locale 服务一致：`{name}` 记号、`t(key, { name })` 传值。
 */
export type RuntimeT = (key: ClientLocaleKey, params?: Record<string, unknown>) => string

/**
 * locale 服务缺席时的回落：直接读中文词典并替换 `{占位符}`。
 *
 * 产出必须与迁移前散在端口里的硬编码串逐字节一致（无 locale 行为不变，
 * tests/runtime-locale.spec.ts 钉住这一点）；替换用单趟正则、函数形式，
 * 参数里的 `$` 序列按字面落进文案，不当替换模式展开；单趟也保证已替换进去的
 * 值里若含 `{name}` 不会被再替换（与宿主 translate 的单趟语义一致）。
 */
export const fallbackT: RuntimeT = (key, params) => {
  const template: string = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}

/** 切换进度条的键。 */
export type ProgressKey = Extract<ClientLocaleKey, `progress.${string}`>

/** 交接卡的键。 */
export type HandoverKey = Extract<ClientLocaleKey, `handover.${string}`>

/** 英文词典，键域与 zh 完全一致。 */
export const en = {
  'panel.label': 'Hosts',
  'progress.preparing': 'Preparing to open the new session · {target}',
  'progress.loading': 'Reading the new session’s history · {target}',
  'progress.ready': 'New session ready, switching · {target}',
  'handover.title': 'Switched to {target}; the conversation moved to the new session',
  'handover.open': 'Open the new session',
  'pairing.label': 'Mobile pairing',
  'pairing.loading': 'Fetching the pairing URL…',
  'pairing.ready.title': 'Scan with your phone',
  'pairing.qr.alt': 'Mobile pairing QR code',
  'pairing.url.hint': 'If scanning is inconvenient, open this URL on the phone:',
  'pairing.guidance.originTitle': 'One step missing: the mobile origin',
  'pairing.guidance.origin': 'This DSH has no mobileOrigin configured yet. Following the docs, set the mobileOrigin field of the threadharbor-mobile-entry plugin in the DSH configuration (the mobile root URL, e.g. https://mac1.example.ts.net), restart DSH, and reload this page.',
  'pairing.guidance.unreachableTitle': 'Pairing URL unavailable',
  'pairing.guidance.unreachable': 'The pairing URL could not be fetched from this host. Make sure this page is opened from the machine serving DSH, then reload and try again.',
  'pairing.guidance.detail': 'Reason: {detail}',

  'panel.title.hosts': 'Hosts',
  'panel.title.addHost': 'Add a new host',
  'panel.title.management': 'Host management',
  'panel.title.selfAgents': 'Agents on this machine',
  'panel.title.connectionCare': 'Who minds the connection',
  'panel.title.notes': 'Notes',
  'panel.button.probe': 'Probe',
  'panel.button.confirm': 'OK',
  'panel.button.save': 'Save',
  'panel.button.cancel': 'Cancel',
  'panel.button.back': '‹ Back',
  'panel.button.backToList': 'Back to list',
  'panel.button.deleteRegistration': 'Delete registration',
  'panel.button.confirmRemove': 'Yes, delete',
  'panel.button.refresh': 'Refresh',
  'panel.button.pickFromTailscale': 'Pick from Tailscale',
  'panel.button.settings': 'Settings',
  'panel.button.reachTry': 'Check reachability',
  'panel.button.copyLink': 'Copy link',
  'panel.status.self': 'This machine',
  'panel.status.online': 'Online',
  'panel.status.offline': 'Not connected',
  'panel.status.connected': 'Connected',
  'panel.status.reachable': 'Reachable',
  'panel.status.checking': 'Checking',
  'panel.status.reachableUnsynced': 'Reachable, not synced',
  'panel.probe.idle': 'Not probed yet',
  'panel.probe.running': 'Probing… (up to a minute)',
  'panel.probe.error': 'Probe failed: {message}',
  'panel.gateway.missing': 'Missing host services: {missing}',
  'panel.gateway.notReady': 'Host services not ready: {error}',
  'panel.verdict.advice': 'Advice',
  'panel.verdict.ok': 'OK',
  'panel.verdict.slow': 'Slow',
  'panel.verdict.hung': 'Stuck',
  'panel.verdict.unreachable': 'Unreachable',
  'panel.verdict.hungStartedDetail': 'picked up work within {ms} ms but never finished',
  'panel.verdict.hungSilentDetail': 'no answer within {ms} ms',
  'panel.verdict.okAdvice': 'It answered at normal speed; nothing to do.',
  'panel.verdict.slowAdvice': 'It came back but past the normal threshold — probe it again; slow is not stuck.',
  'panel.verdict.hungStartedAdvice': "The agent took this turn but never handed it back — it is probably stuck on its side. Check the agent's process and logs on the host; if the connection dropped, the host reconnects on its own at the next turn.",
  'panel.verdict.hungSilentAdvice': "Nothing happened by the deadline — the agent is probably not working. Check the agent's process and logs on the host; if the connection dropped, the host reconnects on its own at the next turn.",
  'panel.verdict.unreachableAdvice': "Check the host's agent address and credentials first; no amount of waiting or reconnecting fixes this.",
  'panel.form.fieldName': 'Name',
  'panel.form.fieldNamePlaceholder': 'e.g. mac-mini',
  'panel.form.fieldStatus': 'Status',
  'panel.form.fieldIp': 'IP',
  'panel.form.ipPlaceholder': '100.101.1.7, with an optional port: 100.101.1.7:3081',
  'panel.form.fieldTitle': 'Display name',
  'panel.posture.host': 'Registrations and this machine\'s name are saved on this machine: a different browser or tab, or a cleared cache, loses nothing.',
  'panel.posture.loading': 'Reading saved registrations from this machine…',
  'panel.posture.memoryRemotePage': 'This page is served by a remote machine: registrations and this machine\'s name live only in this page\'s memory and are gone when the page closes.',
  'panel.posture.memoryNoChannel': 'This machine provides no settings-storage channel (remote.settings): registrations and this machine\'s name live only in this page\'s memory and are gone when the page closes.',
  'panel.posture.degraded': 'Storage on this machine is in trouble: {detail}. The list still lives in this page; until it is truly saved, a different browser or a cleared cache loses it.',
  'panel.time.justNow': 'just now',
  'panel.time.secondsAgo': '{n} seconds ago',
  'panel.time.minutesAgo': '{n} minutes ago',
  'panel.time.hoursAgo': '{n} hours ago',
  'panel.facts.selfLine': 'This is this machine: what shows and edits here is the identity this tab declares for itself.',
  'panel.facts.status': 'Status: {status}',
  'panel.facts.heartbeat': ' · last heartbeat {age}',
  'panel.facts.offlineNote': 'Nothing on the channel announces this host',
  'panel.facts.offlineIdsPrefix': '; announcing now: ',
  'panel.facts.offlineEnd': '.',
  'panel.facts.onlineIdsSeparator': ', ',
  'panel.facts.match': ' (matches what was entered)',
  'panel.facts.idMismatch': ' (differs from what was entered; both stay — set the name to this one and the two line up)',
  'panel.facts.reportedTitle': 'Host-reported name: {name}',
  'panel.registry.removeNote': "Removes it from this machine's registration list only; the remote machine is untouched. Delete?",
  'panel.registry.launchLink': 'Connect (opens the page that carries the token)',
  'panel.reach.probeTimeout': 'The check timed out ({ms} ms)',
  'panel.agents.loading': "Reading this machine's agents…",
  'panel.agents.failed': 'Reading failed: {message}',
  'panel.agents.empty': 'This host lists no acp agents — maybe no preset is configured, or the model catalog read failed; press "Refresh" and try again.',
  'panel.tailscale.pickTitle': 'Pick a machine from Tailscale',
  'panel.tailscale.loading': 'Reading the list…',
  'panel.tailscale.empty': 'The list is empty — only this machine, or not logged in to Tailscale.',
  'panel.tailscale.collapse': 'Collapse',
  'panel.tailscale.peerMeta': '{ip} · {status}',
  'panel.tailscale.noChannel': 'This machine provides no settings channel (remote.settings)',
  'panel.tailscale.badList': 'The list came back malformed and cannot be parsed',
  'panel.tailscale.refreshDenied': 'The refresh request was refused: {error}',
  'panel.notes.selfHeal': 'The host minds its own connections: a broken one is dropped on its own and reconnected at the next turn — nothing to do here.',
  'panel.notes.onlineMeaning': '"Online" = this machine\'s page is open in a same-origin tab of the same browser and announcing on its heartbeat; a closed or crashed page drops out of the list on its own after the quiet window.',
  'panel.notes.otherSource': "Another machine's page (another origin) is not on this channel; its row shows up as \"Not connected\", carried by the registration.",
  'panel.list.empty': 'No hosts yet. Press "Add a new host" to register the first one.',
  // The ssh-deploy section. The intro is two keys because one sentence mixes
  // a <strong> and a <code> segment and richSegments wraps one kind per call;
  // the split sits on a sentence boundary, so reordering stays safe. The
  // `{…}` segments carry their contents per language; counts match zh.
  'panel.ssh.title': 'Automated SSH deploy',
  'panel.ssh.manualEntry': 'Register manually',
  'panel.ssh.intro': 'The remote DSH listens only on 127.0.0.1. Any host with ThreadHarbor installed can SSH to another, read whether the plugin is installed and the tokenized URL, then open a local SSH tunnel to reach it. The private-key path is an absolute path on {this machine}; a pasted private key or password is sent only to this machine\'s DSH process and is never written to a log.',
  'panel.ssh.introLoopback': 'A non-loopback bind never uses 0.0.0.0 and still relies on DSH\'s {?token=} cookie exchange.',
  'panel.ssh.accessMode': 'Access mode',
  'panel.ssh.accessHostIp': 'Host IP (default: the remote side auto-detects its IP and binds it, registering {http://<host IP>:<port>}; no SSH tunnel)',
  'panel.ssh.accessTunnel': 'Local SSH tunnel (remote 127.0.0.1 + local port forwarding)',
  'panel.ssh.bindHostLabel': 'Bind address (optional; leave empty to let the remote side auto-detect its Tailscale / NIC IP)',
  'panel.ssh.bindHostPlaceholder': '192.168.x.x or 100.x.x.x',
  'panel.ssh.trustedHostLabel': '--trusted-host (optional; a MagicDNS name)',
  'panel.ssh.trustedHostPlaceholder': 'mybox.tail1234.ts.net',
  'panel.ssh.targetLabel': 'SSH host',
  'panel.ssh.targetPlaceholder': '192.168.1.10',
  'panel.ssh.portLabel': 'Port',
  'panel.ssh.userLabel': 'User',
  'panel.ssh.userPlaceholder': 'deploy',
  'panel.ssh.proxyJumpLabel': 'ProxyJump (optional)',
  'panel.ssh.authModeLabel': 'Authentication',
  'panel.ssh.authIdentityFile': 'Private key path on this machine',
  'panel.ssh.authIdentityPem': 'Paste PEM private key',
  'panel.ssh.authPassword': 'Password (needs sshpass on this machine)',
  'panel.ssh.identityFileLabel': 'Private key path (on the web-serving host)',
  'panel.ssh.identityFilePlaceholder': '/home/me/.ssh/id_ed25519',
  'panel.ssh.identityPemLabel': 'Private key PEM',
  'panel.ssh.passwordLabel': 'SSH password',
  'panel.ssh.remotePortLabel': 'Remote DSH web port',
  'panel.ssh.remoteAgentsLegend': 'Remote agents (ACP preset)',
  'panel.ssh.remoteAgentsNote': 'Checked agents are enabled in the remote DSH bundle (commands use PATH; the target machine must already have the matching binaries installed). Unchecked ones are disabled after deploy.',
  'panel.ssh.readingPeer': 'Reading…',
  'panel.ssh.readPeer': 'Read remote status over SSH',
  'panel.ssh.peerLoopback': 'The remote side has the plugin installed and DSH listens on 127.0.0.1. Opening the page goes through a local SSH tunnel.',
  'panel.ssh.peerNotLoopback': 'This remote record is not loopback-only. Redeploying will bind to 127.0.0.1 only and reach it through a local tunnel.',
  'panel.ssh.peerMissing': 'There is no ThreadHarbor peer record on the remote side yet (not installed, or installed but not started successfully). You can deploy from here.',
  'panel.ssh.inspect': 'Check SSH host keys',
  'panel.ssh.inspecting': 'Checking…',
  'panel.ssh.deploy': 'Deploy DSH and register',
  'panel.ssh.deploying': 'Deploying…',
  'panel.ssh.pickKeyPrompt': 'Check the fingerprints and pick the one key to trust:',
  'panel.ssh.progressFailed': '({error})',
  'panel.ssh.launchUrlPrompt': 'Open this link to exchange the cookie and go live (already written to the registry):',
  'panel.ssh.open': 'Open',
  'panel.ssh.hostIdLabel': 'Host id (registers the host after the deploy)',
  'panel.ssh.approveFingerprintFirst': 'Check and approve an SSH host key fingerprint first',
  'panel.ssh.hostIdRequired': 'Fill in the host id first',
  'panel.ssh.deployFailed': 'The deploy failed',
  'panel.ssh.registered': 'Registered {endpoint}. After you press "Open" and finish the token exchange in the new tab, the cross-tab channel shows it online.',
  'panel.ssh.addFooterPrefix': 'DSH and ThreadHarbor can also be installed on the remote machine automatically:',
  'panel.ssh.redeploy': 'Redeploy DSH',
  'panel.ssh.upgrade': 'Upgrade reinstall (replace the remote release and restart the service)',
  'panel.ssh.connectOnly': 'Connect (no redeploy)',
  'panel.ssh.progressLogTitle': 'Deploy progress (every phase, verbatim)',
  'panel.ssh.failedTitle': 'Deploy failed — the raw reason:',
  'panel.ssh.retry': 'Retry deploy',
  'panel.use.title': 'Use this host',
  'panel.use.noSsh': 'No SSH connection facts saved for this host yet. Fill them in once (only non-secret facts like a key-file path) and one click connects from then on.',
  'panel.use.fillSsh': 'Fill in the connection',
  'panel.use.tunnel.online': 'Tunnel online: this machine can open its page.',
  'panel.use.tunnel.offline': 'Tunnel down: the local forward port is not answering. Press "Connect and open" to rebuild it.',
  'panel.use.tunnel.checking': 'Checking the tunnel…',
  'panel.use.tunnel.unknown': 'Tunnel not checked yet. The remote DSH listens on its own 127.0.0.1; reaching it from here goes through a local SSH tunnel.',
  'panel.use.connect': 'Connect and open',
  'panel.use.reconnect': 'Reconnect',
  'panel.use.connecting': 'Connecting…',
  'panel.use.check': 'Check tunnel',
  'panel.use.checking': 'Checking…',
  'panel.use.open': 'Open page',
  'panel.use.secretHint': 'This host authenticates with a password or a pasted key, which is never stored: re-enter it under "Remote deploy and plugins", then press "Connect".',
  'panel.use.noCredential': 'No reusable SSH credentials yet (no stored connection, or it uses a password/pasted key). Enter them below and connect.',
  'panel.use.failedTitle': 'Connect failed — the raw reason:',
  'panel.use.retry': 'Retry connect',
  'panel.tree.undeployedNote': 'Not deployed on this host yet — click to open its detail page and deploy.',
  'panel.tree.fetchFailedTitle': 'Fetch failed: ',
  'panel.tree.noSessions': 'No sessions fetched from this host yet.',
  'panel.tree.newSession': 'Start a new session in this project',
  'panel.tree.noHosts': 'No hosts yet.',
  'panel.tree.selfHost': 'This machine',
  'panel.tree.menuTitle': 'More actions',
  'panel.tree.menuRenameWorkspace': 'Rename project',
  'panel.tree.menuDeleteWorkspace': 'Delete project',
  'panel.tree.menuConfirmDelete': 'Confirm delete',
  'panel.tree.menuRenameSession': 'Rename session',
  'panel.tree.menuArchiveSession': 'Archive session',
  'panel.tree.menuPinSession': 'Pin session',
  'panel.tree.menuUnpinSession': 'Unpin',
  'panel.tree.menuForkSession': 'Fork session',
  'panel.tree.expandMore': 'Show {n} more sessions',
  'panel.tree.collapseSessions': 'Collapse',
  'panel.tree.actionFailed': 'Action failed: ',
  'panel.sessionBar.copy': 'Copy',
  'panel.sessionBar.copied': 'Copied',
  'panel.sessionBar.copyFailed': 'Copy failed: ',
  'panel.tree.openFailed': 'Could not open the session: the local UI service is not ready or refused the call.',
  'panel.deploy.expand': 'Remote deploy and plugins (expand)',
  'panel.deploy.collapse': 'Collapse deploy area',
  'panel.ssh.httpInvalid': 'Invalid response (HTTP {status})',
  'panel.ssh.httpFailed': 'Request failed (HTTP {status})',
} satisfies Record<ClientLocaleKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 这份插件自己的文案：侧栏行、切换进度条、交接卡、面板本体。 */
    threadharborClient: ClientLocaleKey
  }
}

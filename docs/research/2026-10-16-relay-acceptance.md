# 云主机中转真机验收（2026-10-16）

环境：云主机 tencent01（212.64.11.60，tailnet 100.84.120.35），公网入口 `https://dsh.agentlab.fun`
（灰云 DNS + Let's Encrypt + nginx 反代 + HTTP 口令）。代码：mobile-relay 分支，部署到
`/root/threadharbor`，实例监听 `127.0.0.1:3080`，`--trusted-host dsh.agentlab.fun`。

**本记录里「通过」只写实际看到输出并核对过的；没做的写「待用户」，不写成通过。**

## 机器侧（可自动验）

| # | 项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 插件装载成功，组合行与配置生效 | 通过 | `GET /threadharbor/mobile/hello` → `200 {"mobile":true}`（公网入口，带口令）。装载期曾报 `$.machines[0].logPath missing required value`，补上 `logPath` 后装载成功——报错点名了缺哪个字段，正是 Task 7b I4 那条修复要的效果 |
| 2 | `/threadharbor/relay/hosts` 返回已登记机器 | 通过 | 返回 `{"hosts":[{"hostId":"tencent01","online":true,"running":true,"reachable":true,"credential":"missing","reason":"credential-missing","detail":"机器 tencent01 的凭据未就绪（no-cookie）"}]}`。`online`（tailnet 发现）、`reachable`（SSH 隧道）、`running`（对端 hello 200）三段都真跑通了。第二台机器**待加**（`japan01`/`jinmac-mini` 在 tailnet 上在线，待配 SSH 与指纹） |
| 3 | 经隧道取 cookie 并代理一次 `session/list` | **不通过** | 隧道已通，但凭据换不到（`credential-missing` / `no-cookie`）。启动令牌换 cookie 这一步尚未走通 |
| 4 | 事件流收到真机 `ready` 帧；手机侧应答 | 待用户 | 手机侧未参与 |
| 5 | 重启后端口分配不变、cookie 复用 | 待用户 | 依赖第 3 项 |
| 6 | 停掉某台机器的 DSH 后该机显示离线、其余不受影响 | 待用户 | 只有一台机器，且隧道未通 |

### 指纹闸门（真机验证，通过）

未登记指纹时中转**不建隧道**，机器显示 `credential: missing` / `reachable: false`，而不是
去连一个没核对过的主机。手工验证：`ssh root@100.84.120.35` 报 `Host key verification failed`，
而清单同时返回 200 与机器条目——拒绝发生在隧道层，不是整个接口挂掉。

## 验收发现的产品缺陷（已修）

**`known_hosts` 的别名没有任何途径能让运维知道。** 中转按 `threadharbor-<sha256(target\0ssh端口) 前24位>`
这个**算出来的别名**查指纹，而不是按 IP。原先 `scripts/relay-setup.sh` 只写「known_hosts 里要有
这台机器的指纹」——照做的人用 `ssh-keyscan` 写进的是 IP 条目，中转查不到，于是那台机器永远
「需先确认指纹」，而症状看起来与「机器离线」几乎一样。

修法：脚本现在**把这个别名算出来并打印**，连同登记命令一起给出（`--ssh-port` 也算进去，
因为别名把 SSH 端口纳入哈希）。真机上按脚本给的值登记后别名核对一致
（`threadharbor-563336ce4c9a9a72687422c7`），本地与云主机算出同一个值。用例 3 条钉住。

## 为什么最初「隧道建不起来」——两次都排错了方向

最初清单是 `reachable:false`，没有任何原因。排查时我先后排除了指纹、SSH 可达、隧道命令本身，
手工跑 `ssh -N -L …` 都是通的，于是**停在「插件内部有问题」这个结论上**——其实方向就错了。

真正的原因是 known_hosts 里那一行**只有别名、没有公钥**（我上一轮追加时把公钥部分丢了），
中转查指纹查不到，于是否决建隧道。证据是最后给清单补上的 `reason`/`detail` 两个字段：
一眼就是 `fingerprint-unapproved`，并直接写出了目标地址。

**教训**：`reachable:false` 是个不吭声的故障——没有信号，现场只能逐个排除，而且很容易
把自己排除过的方向当成已排除的方向。给这类出口**留一个自报状态的字段**，比事后推理便宜得多。

## 未通过项（待查）

**凭据换不到（第 3 项的前置）。** 隧道与探测都通，只有「读启动令牌换 cookie」这一步是
`no-cookie`。已排除的：

- 指纹闸门 —— 别名条目已按脚本给出的值登记，`grep -c '^threadharbor-' known_hosts` = 1；
- SSH 可达 —— `ssh -o BatchMode=yes root@100.84.120.35` 通；
- 隧道命令本身 —— 手工跑 `ssh -N -L 41100:127.0.0.1:3080 -o ExitOnForwardFailure=yes
  -o StrictHostKeyChecking=yes root@100.84.120.35` 无报错跑到超时。

待查：`readLaunchUrl` 读远端启动日志 → 取带令牌网址 → 换 cookie 这条链上具体断在哪一步
（读不到网址？换到但没拿到 cookie？）。**这一项在修好之前，转发与事件仍然不可用**——
机器能看见、能探活，但中转拿不到进那台机器的凭据；单机的手机页不受影响（走既有直连路径）。

## 部署形态（本次实测确认的事实）

- 插件从**包自带的那份补丁文件**（`/root/threadharbor/cordis.patch.yml` 的 `insert:` 列表）装载，
  不是 profile 的 `cordis.patch.yml`。profile 那份**先于** bundle 应用，在里面引用一个还没
  插入的 id 只会得到一条 warn，且配置不会生效——中转的配置因此放在 bundle 层。
- 机器条目必填 `logPath`（凭据过期时中转从那里读新的带令牌网址）。
- `/threadharbor/relay/*` 走 DSH 配对准入：只带 nginx 口令访问返回 `401 unauthorized`，
  这是对的——配对 cookie 仍是第一道，口令只是第二道。
- `/threadharbor/mobile/hello` 不走准入。

## 手机侧（与用户一起做，**全部待用户**）

入口 `https://dsh.agentlab.fun`（口令 `dsh` / 见运维）。按序：

1. 手机浏览器打开入口 → **预期**：出现口令框（无证书警告）。**待用户**
2. 桌面侧栏「手机配对」扫码配对 → **预期**：手机进首页。**待用户**
3. 首屏机器清单 → **预期**：列出登记的机器，每台带在线状态。**待用户**
4. 点某台 → **预期**：该机的会话列表，会话行带机器名。**待用户**
5. 打开会话读历史 → **预期**：能看到之前的内容。**待用户**
6. 发一条消息 → **预期**：桌面端同一会话出现，回复回流。**待用户**
7. 触发一次需批准的操作（桌面同时开着）→ **预期**：手机出现待批横幅且**标明来自哪台机器**；
   点同意 → 桌面端执行。**待用户**
8. 停回合 → **预期**：桌面端会话停住。**待用户**
9. 切到另一台机器 → **预期**：内容整屏换掉，上一台的内容不残留。**待用户**
10. 手机断网再恢复 → **预期**：事件通道回到「已连接」，界面自行恢复。**待用户**

## 核对时间

2026-10-16（机器侧各项）；README 与文档里的核对时间同步更新为 2026-10-16。

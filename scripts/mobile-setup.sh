#!/usr/bin/env bash
# 手机通道一键配置：把本机 DSH 端口发布到 Tailscale 私网。
#
# 用法：
#   mobile-setup.sh <dsh端口>
#   mobile-setup.sh -h | --help
#
# 脚本做三件事：
#   1. 从 `tailscale status --json` 读本机的 ts.net 域名（Self 的 DNS 名）；
#   2. `tailscale serve --bg <dsh端口>`——把本机回环上的 DSH 端口发布为
#      https://<本机域名>/（Let's Encrypt 证书，仅 tailnet 内设备可达）；
#   3. 打印还差的两步配置：dsh 启动时要加的 --trusted-host 行（含启动示例），
#      以及 profile 里的 mobileOrigin 字段值。
#
# 脚本只改 tailscale 的 serve 配置（由 tailscaled 持久保存；若电脑重启后不再
# 生效，重跑一次本脚本即可）；除此之外不改任何东西。撤销发布：`tailscale serve reset`。
# 两步配置的完整说明见 docs/install.zh.md 的「手机通道」一节。
#
# 退出码：0 = serve 已配置，按打印的后续步骤做；1 = 参数不对、tailscale
# 不可用或 serve 失败（都带中文说明）。

set -euo pipefail

usage() { sed -n '2,20p' "$0"; }
die() { echo "mobile-setup: $*" >&2; exit 1; }
info() { echo "mobile-setup: $*"; }

# ---- 参数 --------------------------------------------------------------------
case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") usage >&2; die "缺少参数：<dsh端口>（用法见 --help）" ;;
  -*) die "未知参数：$1（用法见 --help）" ;;
esac
[[ $# -eq 1 ]] || die "参数太多：只需要一个 <dsh端口>（用法见 --help）"

port=$1
case "$port" in
  ''|*[!0-9]*) die "端口必须是纯数字：$port" ;;
  # 前导零一律拒绝而不是归一化：这里是会触发真实发布动作的入口，畸形写法
  # （099）不许被悄悄改写成 99 放行。0 本身落到下面的范围检查里拒绝。
  # bash 3.2 的坑：$var 紧跟全角字符会被当进变量名吞掉，变量一律加花括号。
  0[0-9]*)
    canonical=$((10#$port))
    die "端口不能带前导零：${port}（要发布 $canonical 号端口就直接写 ${canonical}）"
    ;;
esac
(( port >= 1 && port <= 65535 )) || die "端口超出范围（1-65535）：$port"

# ---- tailscale 可用性 --------------------------------------------------------
command -v tailscale >/dev/null 2>&1 ||
  die "找不到 tailscale 命令。请先安装 Tailscale 并登录同一 tailnet（https://tailscale.com/download），再运行本脚本。"

# Self.DNSName 的取法分三层：优先 jq，退回 python3，都没有时用 awk 兜底。
# 三层都只认 Self 块里的 DNSName——Peer 也带 DNSName，兜底若全文找第一个，
# 会在本机没名字时错拿别的机器的名字。三层都取不到（tailscaled 没运行、
# 未登录、JSON 缺 Self）才算失败。
pick_dns_name() {
  local json=$1 out=""
  if command -v jq >/dev/null 2>&1; then
    out="$(jq -r '.Self.DNSName // empty' <<<"$json" 2>/dev/null || true)"
    if [[ -n "$out" ]]; then printf '%s' "$out"; return 0; fi
  fi
  if command -v python3 >/dev/null 2>&1; then
    out="$(python3 -c 'import json,sys
try:
    print(((json.load(sys.stdin).get("Self") or {}).get("DNSName") or "").strip())
except Exception:
    pass' <<<"$json" 2>/dev/null || true)"
    if [[ -n "$out" ]]; then printf '%s' "$out"; return 0; fi
  fi
  # awk 兜底：把状态折成一行后只看 `"Self":` 之后的片段，再剪掉其后第一个
  # `"Peer"` 键起的尾巴——Peer 也带 DNSName，不剪会在本机没名字时错拿别的
  # 机器的名字。找不到（未登录、JSON 缺 Self）就留给上层报错。
  out="$(printf '%s' "$json" | tr -d '\n' | awk '
    {
      if (match($0, /"Self"[[:space:]]*:/)) {
        rest = substr($0, RSTART + RLENGTH)
        if (match(rest, /"Peer"/)) rest = substr(rest, 1, RSTART - 1)
        if (match(rest, /"DNSName"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
          val = substr(rest, RSTART, RLENGTH)
          sub(/.*:[[:space:]]*"/, "", val)
          sub(/"$/, "", val)
          print val
        }
      }
    }
  ' 2>/dev/null || true)"
  if [[ -n "$out" ]]; then printf '%s' "$out"; return 0; fi
  return 1
}

status_json="$(tailscale status --json 2>/dev/null)" ||
  die "tailscale 没在运行或还没登录（tailscale status 失败）。请先启动 Tailscale 并登录，再运行本脚本。"

dns_name="$(pick_dns_name "$status_json")" ||
  die "读不到本机的 ts.net 域名（状态输出里没有 Self.DNSName）。请确认 Tailscale 已登录本机，再重试。"
dns_name="${dns_name%.}"   # tailscale 给的 DNS 名带结尾点，URL 里不能带
case "$dns_name" in
  ''|.*|*[!A-Za-z0-9.-]*) die "本机域名形状不对：${dns_name}。请确认 Tailscale 已登录本机；也可以按 docs/install.zh.md「手机通道」一节手工配置。" ;;
esac

# ---- 发布端口 ----------------------------------------------------------------
info "把本机 $port 端口发布为 https://$dns_name/ ..."
if ! tailscale serve --bg "$port"; then
  die "tailscale serve --bg $port 失败。常见原因：443 端口被占用、HTTPS 证书签发失败、tailscale 版本过旧。可运行 tailscale serve status 查看现状，处理后重试。"
fi

# ---- 后续两步（与 docs/install.zh.md「手机通道」一致）------------------------
cat <<EOF

手机通道已发布：https://$dns_name/  →  http://127.0.0.1:$port

还差两步配置（详见 docs/install.zh.md「手机通道」）：

1. dsh 启动时加信任主机，不加的话手机访问会被 403 拒绝：

     --trusted-host $dns_name

   启动示例：

     dsh --profile web --trusted-host $dns_name --port $port

   开发实例走 scripts/dev.sh 时，导出变量即可透传：

     THREADHARBOR_TRUSTED_HOST=$dns_name scripts/dev.sh restart web

2. 在 profile 的 cordis.patch.yml（\$DSH_HOME/profiles/web/cordis.patch.yml）
   里给 threadharbor-mobile-entry 行配 mobileOrigin（注意：https 开头、
   不带路径、结尾没有斜杠）：

     - id: threadharbor-mobile-entry
       config:
         mobileOrigin: https://$dns_name

改完重启 dsh，桌面端侧栏「手机配对」面板就能出二维码，手机扫码完成配对。
撤销发布：tailscale serve reset
EOF

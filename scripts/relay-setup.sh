#!/usr/bin/env bash
#
# 生成 ThreadHarbor 中转（手机经云主机连多台机器）的组合行片段。
#
# 这个脚本**只打印**，不改任何文件、不调 SSH：它跑在运维的机器上，而它输出的
# 片段是要人抄进云主机的 cordis.patch.yml 的。抄错一行就是一台机器连不上，
# 所以参数校验宁严勿松——下面每一条拒绝理由都对应一种会真出事的抄错。
#
# 用法：
#   scripts/relay-setup.sh --host <tailnet 名> --target <ssh 目标> --remote-port <dsh 端口> \
#                          [--user <用户>] [--identity <私钥路径>]
#   scripts/relay-setup.sh --help

set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  scripts/relay-setup.sh --host <tailnet 名> --target <ssh 目标> --remote-port <dsh 端口> \
                         [--user <用户>] [--identity <私钥路径>]

参数：
  --host         机器在 tailnet 里的名字（如 gooddemacbook-pro）。不接受大写字母、
                 尾点与空白——MagicDNS 名对不上就是「在清单里永远离线」。
  --target       中转连它用的地址（tailnet IP 或名字）。
  --remote-port  那台机器上 DSH 监听的端口（1–65535 的整数，不接受 099 这类前导零）。
  --user         SSH 用户名（缺省沿用本机登录名）。
  --identity     私钥绝对路径（缺省用 ssh 自己的默认私钥）。
  --ssh-port     中转连它用的 SSH 端口（缺省 22）。它只影响 known_hosts 的别名。

输出：可抄进云主机 cordis.patch.yml 的组合行片段。脚本不改任何文件。
EOF
}

die() {
  echo "错误：$*" >&2
  exit 1
}

HOST=''
TARGET=''
REMOTE_PORT=''
USER_NAME=''
IDENTITY=''
SSH_PORT=22

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --host)
      [ $# -ge 2 ] || die "--host 后面要跟机器名"
      HOST="$2"
      shift 2
      ;;
    --target)
      [ $# -ge 2 ] || die "--target 后面要跟地址"
      TARGET="$2"
      shift 2
      ;;
    --remote-port)
      [ $# -ge 2 ] || die "--remote-port 后面要跟端口"
      REMOTE_PORT="$2"
      shift 2
      ;;
    --user)
      [ $# -ge 2 ] || die "--user 后面要跟用户名"
      USER_NAME="$2"
      shift 2
      ;;
    --identity)
      [ $# -ge 2 ] || die "--identity 后面要跟私钥路径"
      IDENTITY="$2"
      shift 2
      ;;
    --ssh-port)
      [ $# -ge 2 ] || die "--ssh-port 后面要跟端口"
      SSH_PORT="$2"
      shift 2
      ;;
    *)
      die "不认识的参数 $1（--help 看用法）"
      ;;
  esac
done

[ -n "$HOST" ] || die "--host 必填"
[ -n "$TARGET" ] || die "--target 必填"
[ -n "$REMOTE_PORT" ] || die "--remote-port 必填"

# tailnet 名：不含空白、不含大写、不能以点结尾。这里刻意与装载期那道校验同形——
# 抄进配置的值将来会被原样拿去查 tailnet 与拼 SSH 命令，宽松一点就是命令注入面。
case "$HOST" in
  *[[:space:]]*) die "机器名不能含空白：$HOST" ;;
esac
case "$HOST" in
  *[A-Z]*) die "tailnet 机器名不能有大写字母（MagicDNS 名全小写）：$HOST" ;;
esac
case "$HOST" in
  *[!A-Za-z0-9_.-]*) die "tailnet 机器名含非法字符（只接受字母数字、点、下划线与连字符）：$HOST" ;;
esac
case "$HOST" in
  .) die "机器名不能是单点" ;;
  *.|*.*.*) die "机器名不能含点（只填短名，不要填完整域名）：$HOST" ;;
esac

# ssh 目标：只放行地址与主机名字符。
case "$TARGET" in
  *[!A-Za-z0-9._:-]*) die "target 含非法字符（只接受地址或主机名）：$TARGET" ;;
esac

# 端口：纯十进制、无前导零、1–65535。
case "$REMOTE_PORT" in
  0[0-9]*)
    die "端口不能写成前导零形态（099 会被当成字符串或八进制）：$REMOTE_PORT"
    ;;
  ''|*[!0-9]*)
    die "端口必须是十进制整数：$REMOTE_PORT"
    ;;
esac
if [ "$REMOTE_PORT" -lt 1 ] || [ "$REMOTE_PORT" -gt 65535 ]; then
  die "端口要在 1–65535 之间：$REMOTE_PORT"
fi

if [ -n "$USER_NAME" ]; then
  case "$USER_NAME" in
    *[!A-Za-z0-9._-]*) die "用户名含非法字符：$USER_NAME" ;;
  esac
fi
case "$SSH_PORT" in
  0[0-9]*)
    die "SSH 端口不能写成前导零形态：$SSH_PORT"
    ;;
  ''|*[!0-9]*)
    die "SSH 端口必须是十进制整数：$SSH_PORT"
    ;;
esac
if [ "$SSH_PORT" -lt 1 ] || [ "$SSH_PORT" -gt 65535 ]; then
  die "SSH 端口要在 1-65535 之间：$SSH_PORT"
fi

if [ -n "$IDENTITY" ]; then
  case "$IDENTITY" in
    /*) ;;
    *) die "私钥路径要用绝对路径：$IDENTITY" ;;
  esac
fi

# 中转查 known_hosts 用的别名：sha256("<target>\0<ssh端口>") 前 24 位十六进制。
# 与 packages/dsh-mobile-relay/src/tunnels.ts 的 hostKeyAlias 同式——运维侧没有
# 别的途径知道这个别名，所以脚本必须把它算出来。
ALIAS="threadharbor-$(printf '%s\0%s' "$TARGET" "$SSH_PORT" | shasum -a 256 | cut -c1-24)"
KNOWN_HOSTS="${KNOWN_HOSTS:-/root/.ssh/known_hosts}"

cat <<EOF
把下面这段加进云主机的 cordis.patch.yml（按需改 mobileOrigin 与 statePath）：

  - id: threadharbor-mobile-relay
    config:
      # 手机访问的源，必须与 nginx 反代的 server_name 同名（origin 绑定会逐字比对）。
      mobileOrigin: https://dsh.agentlab.fun
      sshKnownHostsPath: /root/.ssh/known_hosts
      # 端口分配与凭据的家；重启后必须还是同一个路径，否则端口要重分、cookie 全部失效。
      statePath: /root/.local/state/threadharbor/relay/state.json
      machines:
        - hostId: ${HOST}
          target: ${TARGET}
          remotePort: ${REMOTE_PORT}
$(if [ -n "$USER_NAME" ]; then echo "          user: ${USER_NAME}"; fi)$(if [ -n "$IDENTITY" ]; then echo "          identityFile: ${IDENTITY}"; fi)

机器侧还要做的三件事：

  1. known_hosts 里要有这台机器的指纹，**而且要挂在下面这个别名下**（不是 IP）：

       ${ALIAS}

     中转按别名查指纹，查不到就不建隧道，那台机器在清单上永远显示「需先确认
     指纹」——症状与「机器离线」很像，但它拒绝的是没核对过的主机。
     人工登记一行（先 ssh-keyscan 核对再写进去）：

       ssh-keyscan -t ed25519 ${TARGET} > /tmp/th-key
       echo "${ALIAS} \$(cat /tmp/th-key)" >> ${KNOWN_HOSTS}

  2. 那台机器的 DSH 要监听 127.0.0.1:${REMOTE_PORT}——公网不经它。
  3. 中转自身：dsh 启动要带 --trusted-host <mobileOrigin 的主机名>，否则中转
     自己的请求一律 403。
EOF

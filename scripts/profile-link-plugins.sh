#!/usr/bin/env bash
# 把 threadharbor 的插件包软链同步进一个 dsh profile —— web 与桌面版跑同一条流程。
#
# 唯一事实来源是本仓库自己的工作区（node_modules/@threadharbor/，pnpm 维护；
# 部署切换工作树时改这里即可），profile 一侧只做镜像：
#
#   scripts/profile-link-plugins.sh ~/.dsh-web/profiles/web
#   scripts/profile-link-plugins.sh ~/.dsh/profiles/desktop
#
# 幂等：已存在且指向一致的软链原样保留；目标不一致的按仓库现状重指。
# 需要先行完成的一次性步骤（本脚本只校验、不代办）：profile 的 package.json
# 以 `threadharbor: link:<仓库>` 引用本仓库，并跑过一次 pnpm install。
#
# 2026-10-20 桌面版输入框裸模型名的根因之一：web 装过这组软链、桌面没装，
# 宿主侧插件照常挂载掩盖了客户端包缺席。此脚本让两边不再各自为政。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:?usage: profile-link-plugins.sh <profile-dir>}"
PROFILE_DIR="$(cd "$PROFILE" && pwd)"
NODE_MODULES="$PROFILE_DIR/node_modules"
SCOPE="$NODE_MODULES/@threadharbor"

if [ ! -d "$REPO/node_modules/@threadharbor" ]; then
	echo "error: $REPO/node_modules/@threadharbor 不存在 —— 先在仓库里跑 pnpm install" >&2
	exit 1
fi

# bundle 链接：profile 必须经 `threadharbor -> <仓库>` 引用整仓（宿主组合层的入口）。
if [ -L "$NODE_MODULES/threadharbor" ]; then
	target="$(readlink "$NODE_MODULES/threadharbor")"
	resolved="$(cd "$NODE_MODULES" && cd "$(dirname "$target")" && pwd)/$(basename "$target")"
	if [ "$resolved" != "$REPO" ]; then
		echo "warn: $NODE_MODULES/threadharbor 指向 $resolved 而不是 $REPO；不改，请人工确认" >&2
	fi
else
	echo "warn: $NODE_MODULES/threadharbor 缺失 —— profile 需要先以 link: 依赖引用本仓库并 pnpm install" >&2
fi

mkdir -p "$SCOPE"
synced=0
for link in "$REPO/node_modules/@threadharbor"/*; do
	name="$(basename "$link")"
	# 仓库侧统一解析成绝对路径，profile 侧一律指到同一个物理目录。
	abs_target="$(cd "$link" && pwd -P)"
	if [ -L "$SCOPE/$name" ] && [ "$(cd "$SCOPE/$name" 2>/dev/null && pwd -P)" = "$abs_target" ]; then
		continue
	fi
	ln -sfn "$abs_target" "$SCOPE/$name"
	echo "linked $name -> $abs_target"
	synced=$((synced + 1))
done

if [ "$synced" -eq 0 ]; then
	echo "profile 已与仓库工作区一致：$PROFILE_DIR"
else
	echo "synced $synced link(s) into $PROFILE_DIR"
fi

#!/bin/bash
# ============================================
# auto-update.sh - 自动检测 GitHub 更新并部署
# 放置在服务器 ~/wb/auto-update.sh
# 配合 crontab 每 2 分钟检查一次
# ============================================

# 加载 shell 配置文件（cron 环境下不会自动加载）
source "$HOME/.bashrc" 2>/dev/null
source "$HOME/.profile" 2>/dev/null

REPO_OWNER="april-and-aluo"
REPO_NAME="public-whiteboard"
BRANCH="main"
WORK_DIR="$HOME/wb"
PUBLIC_DIR="$WORK_DIR/public"
STATE_FILE="$WORK_DIR/.last-commit-hash"
LOG_FILE="$WORK_DIR/update.log"

# 需要同步的前端文件
FRONTEND_FILES=(
  "src/main.js"
  "src/yjs-sync.js"
  "src/canvas-engine.js"
  "src/index.html"
  "src/styles.css"
  "src/config.js"
  "src/cursor-layer.js"
  "src/export.js"
  "src/map-layer.js"
  "src/reward-qrcode.png"
  "src/map-data/style.json"
  "src/map-data/countries.geojson"
  "src/map-data/admin1.geojson"
  "announcement.json"
)

# 需要同步的服务器文件（格式: "源文件:目标文件名"）
SERVER_FILES=(
  "server/combined.js:server.js"
  "server/package.json:package.json"
  "deploy/auto-update.sh:auto-update.sh"
)

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# 获取 GitHub 最新 commit hash
# 方法1: jsDelivr API（不限流）— 匹配 "version":"hash"（跳过 null）
LATEST_HASH=$(curl -s "https://data.jsdelivr.com/v1/packages/gh/${REPO_OWNER}/${REPO_NAME}/resolved" 2>/dev/null | grep -o '"version": *"[^"]*"' | head -1 | grep -o '[a-f0-9]\{7,\}' | head -1)

# 方法2: GitHub API（需要认证以避免限流）
if [ -z "$LATEST_HASH" ]; then
  if [ -n "$GH_TOKEN" ]; then
    LATEST_HASH=$(curl -s -H "Authorization: token ${GH_TOKEN}" "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits/${BRANCH}" 2>/dev/null | grep '"sha"' | head -1 | cut -d'"' -f4)
  else
    LATEST_HASH=$(curl -s "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits/${BRANCH}" 2>/dev/null | grep '"sha"' | head -1 | cut -d'"' -f4)
  fi
fi

# 方法3: git ls-remote（最可靠，不消耗 API 配额）
if [ -z "$LATEST_HASH" ]; then
  LATEST_HASH=$(git ls-remote "https://github.com/${REPO_OWNER}/${REPO_NAME}.git" "refs/heads/${BRANCH}" 2>/dev/null | cut -f1)
fi

if [ -z "$LATEST_HASH" ]; then
  log "ERROR: 无法获取 GitHub commit hash"
  exit 1
fi

# 读取上次记录的 hash
LAST_HASH=""
if [ -f "$STATE_FILE" ]; then
  LAST_HASH=$(cat "$STATE_FILE")
fi

# 比较是否有更新
if [ "$LATEST_HASH" = "$LAST_HASH" ]; then
  # 无更新，静默退出
  exit 0
fi

log "检测到新更新: $LAST_HASH -> $LATEST_HASH"

# 下载前端文件到 public 目录
UPDATED=0
for file in "${FRONTEND_FILES[@]}"; do
  filename=$(basename "$file")
  url="https://cdn.jsdelivr.net/gh/${REPO_OWNER}/${REPO_NAME}@${LATEST_HASH}/${file}"
  
  # 如果是前端 src/ 下的文件，放到 public/
  if [[ "$file" == src/map-data/* ]]; then
    mkdir -p "$PUBLIC_DIR/map-data"
    target="$PUBLIC_DIR/map-data/$filename"
  elif [[ "$file" == src/* ]]; then
    target="$PUBLIC_DIR/$filename"
  elif [[ "$file" == announcement.json ]]; then
    target="$PUBLIC_DIR/$filename"
  else
    target="$PUBLIC_DIR/$filename"
  fi
  
  curl -sfL --max-time 120 "$url" > "$target.tmp" 2>/dev/null
  if [ $? -eq 0 ] && [ -s "$target.tmp" ]; then
    mv "$target.tmp" "$target"
    log "  更新: $file -> $target"
    UPDATED=$((UPDATED + 1))
  else
    rm -f "$target.tmp"
    log "  WARN: 下载失败或截断 $file"
  fi
done

# 下载服务器文件
for entry in "${SERVER_FILES[@]}"; do
  file="${entry%%:*}"
  target_name="${entry##*:}"
  url="https://cdn.jsdelivr.net/gh/${REPO_OWNER}/${REPO_NAME}@${LATEST_HASH}/${file}"
  target="$WORK_DIR/$target_name"
  
  curl -sL --max-time 30 "$url" > "$target.tmp" 2>/dev/null
  if [ -s "$target.tmp" ]; then
    mv "$target.tmp" "$target"
    log "  更新: $file -> $target"
    UPDATED=$((UPDATED + 1))
  else
    rm -f "$target.tmp"
    log "  WARN: 下载失败 $file"
  fi
done

# 更新 hash 记录
echo "$LATEST_HASH" > "$STATE_FILE"

if [ $UPDATED -gt 0 ]; then
  log "共更新 $UPDATED 个文件，安装依赖..."
  cd "$WORK_DIR" && npm install --production 2>&1 >> "$LOG_FILE"
  if [ $? -eq 0 ]; then
    log "依赖安装完成，重启服务..."
    sudo systemctl restart whiteboard
    log "服务已重启"
  else
    log "ERROR: 依赖安装失败，跳过重启"
  fi
else
  log "无文件需要更新"
fi

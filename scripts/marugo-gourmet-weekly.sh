#!/usr/bin/env bash
# MARUGO S グルメサイト週報（HTML）を GitHub Pages に公開し、そのリンクを
# LINE グループ「マルゴエス運営チーム」(C51a3c2386cb1fc4247139bed89d45f52) へ 1 通送る。
# 共有の作業用コンピューター（box）から、毎週土曜 10:00 ごろ定期作業として呼ぶ想定。
#
#   scripts/marugo-gourmet-weekly.sh --html <report.html> \
#     --summary $'1行目\n2行目\n3行目' [--date YYYY-MM-DD] [--dry-run]
#
#   (a) public/marugo-s/gourmet-report/<日付>.html と latest.html に置き、main へ commit & push
#       （専用の作業用 clone: $MARUGO_PUBLISH_DIR、既定 ~/.marugo-line/line_report-publish）
#   (b) 公開 URL が 200 で同じ内容を返すまで待つ（既定 12 分）
#   (c) Edge Function marugo-gourmet-weekly-line に送信を依頼（本文は関数側で
#       「【MARUGO S グルメサイト週報 YYYY/MM/DD】\n要約\nURL」に固定）
#   (d) --dry-run: 公開と待機まで行い、関数を dry_run で呼んで送る本文・送り先・確認結果を表示（LINE へは送らない）
#
# 二重送信防止: 関数側（marugo_gourmet_weekly_line_sends、日付ごとに1回）と、
# 手元の記録（~/.marugo-line/gourmet-weekly-sent/<日付>）の両方。
# 呼び出しキー: ~/.marugo-line/gourmet_weekly_key（600。値は表示しない）。
set -euo pipefail

REPO_URL="https://github.com/MARUGO-s/line_report.git"
FN_URL="${MARUGO_GOURMET_WEEKLY_FN_URL:-https://hocbnifuactbvmyjraxy.supabase.co/functions/v1/marugo-gourmet-weekly-line}"
PAGES_BASE="https://marugo-s.github.io/line_report/marugo-s/gourmet-report"
STATE_DIR="${MARUGO_LINE_STATE_DIR:-$HOME/.marugo-line}"
PUBLISH_DIR="${MARUGO_PUBLISH_DIR:-$STATE_DIR/line_report-publish}"
KEY_FILE="${MARUGO_GOURMET_WEEKLY_KEY_FILE:-$STATE_DIR/gourmet_weekly_key}"
SENT_DIR="$STATE_DIR/gourmet-weekly-sent"
WAIT_SECONDS="${MARUGO_PAGES_WAIT_SECONDS:-720}"

html="" summary="" report_date="" dry_run=0 skip_publish=0
usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --html) html="${2:-}"; shift 2 ;;
    --summary) summary="${2:-}"; shift 2 ;;
    --date) report_date="${2:-}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --skip-publish) skip_publish=1; shift ;;   # 公開済みの日付を送り直すとき（HTML の差し替えなし）
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

log() { printf '[%s] %s\n' "$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M:%S JST')" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

[ -n "$report_date" ] || report_date="$(TZ=Asia/Tokyo date +%F)"
[[ "$report_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "--date は YYYY-MM-DD"
summary="${summary//\\n/$'\n'}"   # 文字どおりの \n も改行として扱う
[ -n "$(printf '%s' "$summary" | tr -d '[:space:]')" ] || die "--summary（3行まで）が必要です"
[ "$(printf '%s\n' "$summary" | grep -c '[^[:space:]]')" -le 3 ] || die "--summary は3行まで"
[ -f "$KEY_FILE" ] || die "呼び出しキーがありません: $KEY_FILE"
command -v jq >/dev/null || die "jq が必要です"

url="$PAGES_BASE/$report_date.html"
mkdir -p "$SENT_DIR"
if [ "$dry_run" -eq 0 ] && [ -e "$SENT_DIR/$report_date" ]; then
  log "この日付（$report_date）は送信済みです（$SENT_DIR/$report_date）。何もしません。"
  exit 0
fi

# ---------- (a) 公開 ----------
if [ "$skip_publish" -eq 0 ]; then
  [ -n "$html" ] && [ -f "$html" ] || die "--html のファイルがありません: $html"
  if [ ! -d "$PUBLISH_DIR/.git" ]; then
    log "公開用の clone を作成: $PUBLISH_DIR"
    mkdir -p "$(dirname "$PUBLISH_DIR")"
    git clone --quiet --filter=blob:none --branch main "$REPO_URL" "$PUBLISH_DIR"
  fi
  cd "$PUBLISH_DIR"
  git config user.name >/dev/null || git config user.name "MARUGO-s"
  git config user.email >/dev/null || git config user.email "marugo-s@users.noreply.github.com"
  dest_dir="public/marugo-s/gourmet-report"
  pushed=0
  for attempt in 1 2 3 4; do
    git fetch --quiet origin main
    git checkout --quiet -B main origin/main   # 専用 clone なので常に origin/main にそろえる
    git reset --quiet --hard origin/main
    mkdir -p "$dest_dir"
    # 検索エンジンに載せない（公開 URL だが一覧・検索の対象外にする）
    if grep -qi 'name="robots"' "$html"; then
      cp "$html" "$dest_dir/$report_date.html"
    else
      perl -0pe 's/(<head[^>]*>)/$1\n<meta name="robots" content="noindex,nofollow">/i' "$html" > "$dest_dir/$report_date.html"
    fi
    cp "$dest_dir/$report_date.html" "$dest_dir/latest.html"
    git add "$dest_dir/$report_date.html" "$dest_dir/latest.html"
    if git diff --cached --quiet; then
      log "公開内容に変更なし（main に同じ HTML があります）"
      pushed=1; break
    fi
    git commit --quiet -m "chore(marugo-s): グルメサイト週報 $report_date を公開"
    if git push --quiet origin main; then
      log "main へ push: $(git rev-parse --short HEAD)"
      pushed=1; break
    fi
    log "push が競合しました。やり直します（$attempt）"
    sleep $((attempt * 5))
  done
  [ "$pushed" -eq 1 ] || die "main への push に失敗しました"
  local_sha="$(sha256sum "$dest_dir/$report_date.html" | cut -d' ' -f1)"

  # ---------- (b) Pages の反映待ち ----------
  log "公開を待っています: $url（最大 ${WAIT_SECONDS} 秒）"
  deadline=$(( $(date +%s) + WAIT_SECONDS ))
  live=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    tmp="$(mktemp)"
    code="$(curl -sS -o "$tmp" -w '%{http_code}' -H 'Cache-Control: no-cache' "$url?v=$(date +%s)" || echo 000)"
    if [ "$code" = "200" ] && [ "$(sha256sum "$tmp" | cut -d' ' -f1)" = "$local_sha" ]; then
      rm -f "$tmp"; live=1; break
    fi
    rm -f "$tmp"
    sleep 20
  done
  [ "$live" -eq 1 ] || die "公開 URL がまだ見られません（$url）。Actions の Deploy GitHub Pages を確認してください"
  log "公開を確認しました: $url"
fi

# ---------- (c)/(d) LINE 送信（または dry-run） ----------
payload="$(jq -n --arg d "$report_date" --arg s "$summary" --arg u "$url" --argjson dry "$([ "$dry_run" -eq 1 ] && echo true || echo false)" \
  '{report_date: $d, summary: $s, url: $u, dry_run: $dry}')"
hdr="$(mktemp)"; chmod 600 "$hdr"
trap 'rm -f "$hdr"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '[:space:]' < "$KEY_FILE")" > "$hdr"
resp_file="$(mktemp)"
status="$(curl -sS -o "$resp_file" -w '%{http_code}' -X POST "$FN_URL" -H @"$hdr" -H 'Content-Type: application/json' --data-binary "$payload" || echo 000)"
rm -f "$hdr"
resp="$(cat "$resp_file")"; rm -f "$resp_file"
printf '%s\n' "$resp" | jq . 2>/dev/null || printf '%s\n' "$resp"

if [ "$dry_run" -eq 1 ]; then
  [ "$status" = "200" ] || die "dry-run の確認に失敗しました（HTTP $status）"
  log "dry-run: LINE へは送っていません。上の text が送る本文です。"
  exit 0
fi
if [ "$status" = "200" ] && [ "$(printf '%s' "$resp" | jq -r '.ok')" = "true" ]; then
  printf '%s\n' "$url" > "$SENT_DIR/$report_date"
  if [ "$(printf '%s' "$resp" | jq -r '.skipped // empty')" = "already_sent" ]; then
    log "送信済みだったため送っていません（$report_date）"
  else
    log "LINE へ送信しました（$report_date）"
  fi
  exit 0
fi
die "LINE 送信に失敗しました（HTTP $status）"

#!/usr/bin/env bash
# Integration test for the S3 post-upload validation Lambda (S3Handler):
#   valid image             -> pending record moves to "active", S3 object kept (re-encoded)
#   oversized file          -> pending record moves to "rejected", S3 object deleted
#   renamed .exe            -> pending record moves to "rejected" (magic-bytes mismatch), S3 object deleted
#
# This drives the Lambda directly at the AWS-SDK level (creates the PENDING#
# DynamoDB record + uploads/ S3 object the same way app/api/upload-url does),
# rather than going through the Next.js app + Cognito login.
#
# Usage: ./scripts/test-s3-upload-handler.sh [stack-name]   (default: MemeDayDev)
# Run with creds loaded (dotenv-cli lives in infra/):
#   cd infra && npx dotenv -e ../.env -- ../scripts/test-s3-upload-handler.sh
set -uo pipefail

STACK="${1:-MemeDayDev}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

get_output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null
}

REGION="$(get_output Region)"
if [ -z "$REGION" ] || [ "$REGION" = "None" ]; then
  REGION="${AWS_REGION:-eu-west-1}"
fi
export AWS_DEFAULT_REGION="$REGION"

BUCKET="$(get_output BucketName)"
TABLE="$(get_output TableName)"
if [ -z "$BUCKET" ] || [ "$BUCKET" = "None" ] || [ -z "$TABLE" ] || [ "$TABLE" = "None" ]; then
  echo "Stack '$STACK' has no BucketName/TableName outputs — no S3 handler deployed there. Nothing to test."
  exit 1
fi

DIR="$(mktemp -d)"
USER="test-user-$(date +%s)"
PASS=0
FAIL=0

# --- fixtures ---
# Real 800x800 PNG (within the 600-4096px window) via the project's sharp dep.
node -e "
require('$REPO_ROOT/node_modules/sharp')({
  create: { width: 800, height: 800, channels: 3, background: { r: 100, g: 150, b: 200 } }
}).png().toFile('$DIR/valid.png').catch((e) => { console.error(e); process.exit(1); });
"
# Oversized (>5MB) — Lambda checks size before decoding, so content doesn't
# need to be a real image for this case.
head -c $((6 * 1024 * 1024)) /dev/urandom > "$DIR/oversized.png"
# Renamed .exe — real PE header (MZ magic bytes), .png extension.
printf 'MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00' > "$DIR/fake.png"
head -c 1024 /dev/urandom >> "$DIR/fake.png"
# Oversized dimensions (>4096px) — within the 5MB size cap so it reaches the dimension check.
node -e "
require('$REPO_ROOT/node_modules/sharp')({
  create: { width: 4200, height: 4200, channels: 3, background: { r: 100, g: 150, b: 200 } }
}).png().toFile('$DIR/toobig.png').catch((e) => { console.error(e); process.exit(1); });
"

put_pending() { # $1=pendingId $2=s3Key
  aws dynamodb put-item --table-name "$TABLE" --item "$(cat <<JSON
{
  "PK": {"S": "PENDING#$1"},
  "SK": {"S": "PENDING#$1"},
  "pendingId": {"S": "$1"},
  "creatorId": {"S": "$USER"},
  "s3Key": {"S": "$2"},
  "caption": {"S": "test upload"},
  "status": {"S": "pending_upload"},
  "createdAt": {"S": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"},
  "expiresAt": {"N": "$(( $(date +%s) + 86400 ))"}
}
JSON
)"
}

get_status() { # $1=pendingId -> prints status, sets $REASON
  local out
  out="$(aws dynamodb get-item --table-name "$TABLE" \
    --key "{\"PK\":{\"S\":\"PENDING#$1\"},\"SK\":{\"S\":\"PENDING#$1\"}}" \
    --output json 2>/dev/null)"
  REASON="$(echo "$out" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('Item',{}).get('reason',{}).get('S',''))" 2>/dev/null)"
  echo "$out" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('Item',{}).get('status',{}).get('S','MISSING'))" 2>/dev/null
}

s3_exists() {
  aws s3api head-object --bucket "$BUCKET" --key "$1" >/dev/null 2>&1
}

wait_status() { # $1=pendingId -> waits until status != pending_upload, prints final status
  local pendingId="$1" status
  for _ in $(seq 1 15); do
    status="$(get_status "$pendingId")"
    [ "$status" != "pending_upload" ] && [ "$status" != "MISSING" ] && { echo "$status"; return; }
    sleep 2
  done
  echo "$status"
}

run_case() { # $1=desc $2=file $3=ext $4=expected(active|rejected)
  local desc="$1" file="$2" ext="$3" expected="$4"
  local pendingId key status
  pendingId="$(node -e "console.log(require('crypto').randomUUID())")"
  key="uploads/$USER/$pendingId.$ext"

  put_pending "$pendingId" "$key" >/dev/null
  aws s3 cp "$file" "s3://$BUCKET/$key" --only-show-errors

  status="$(wait_status "$pendingId")"
  if [ "$status" = "$expected" ]; then
    echo "PASS: $desc -> pending status = $status${REASON:+ (reason: $REASON)}"
    PASS=$((PASS+1))
  else
    echo "FAIL: $desc -> expected status=$expected, got status=$status${REASON:+ (reason: $REASON)}"
    FAIL=$((FAIL+1))
  fi

  if [ "$expected" = "rejected" ]; then
    if s3_exists "$key"; then
      echo "FAIL: $desc -> S3 object still present, should be deleted"; FAIL=$((FAIL+1))
    else
      echo "PASS: $desc -> S3 object deleted"; PASS=$((PASS+1))
    fi
  else
    if s3_exists "$key"; then
      echo "PASS: $desc -> S3 object kept (re-encoded)"; PASS=$((PASS+1))
    else
      echo "FAIL: $desc -> S3 object missing, should be kept"; FAIL=$((FAIL+1))
    fi

    # Active case: simulate what POST /api/memes (finalizeMeme) does once the
    # user confirms the upload, so a real MEME# item briefly exists — same as
    # it would if this went through the app. Clean it up so the test run
    # doesn't leave a meme showing up as meme-of-day or in browse.
    local now
    now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    aws dynamodb put-item --table-name "$TABLE" --item "$(cat <<JSON
{
  "PK": {"S": "MEME#$pendingId"},
  "SK": {"S": "MEME#$pendingId"},
  "GSI1PK": {"S": "USER#$USER"},
  "GSI1SK": {"S": "MEME#$now"},
  "GSI2PK": {"S": "OWNER#$USER"},
  "GSI2SK": {"S": "MEME#$now"},
  "memeId": {"S": "$pendingId"},
  "creatorId": {"S": "$USER"},
  "ownerId": {"S": "$USER"},
  "s3Key": {"S": "$key"},
  "caption": {"S": "test upload"},
  "status": {"S": "active"},
  "likeCount": {"N": "0"},
  "commentCount": {"N": "0"},
  "score": {"N": "0"},
  "createdAt": {"S": "$now"}
}
JSON
)" >/dev/null
    echo "PASS: $desc -> meme created (simulates POST /api/memes)"; PASS=$((PASS+1))

    aws dynamodb delete-item --table-name "$TABLE" \
      --key "{\"PK\":{\"S\":\"MEME#$pendingId\"},\"SK\":{\"S\":\"MEME#$pendingId\"}}" >/dev/null 2>&1
    aws s3 rm "s3://$BUCKET/$key" --only-show-errors >/dev/null 2>&1
    if s3_exists "$key"; then
      echo "FAIL: $desc -> test image/meme not cleaned up, still visible in feed"; FAIL=$((FAIL+1))
    else
      echo "PASS: $desc -> test meme + image deleted (won't show as meme of the day / in browse)"; PASS=$((PASS+1))
    fi
  fi

  # cleanup
  aws dynamodb delete-item --table-name "$TABLE" \
    --key "{\"PK\":{\"S\":\"PENDING#$pendingId\"},\"SK\":{\"S\":\"PENDING#$pendingId\"}}" >/dev/null 2>&1
  aws s3 rm "s3://$BUCKET/$key" --only-show-errors >/dev/null 2>&1
}

echo "stack:  $STACK"
echo "bucket: $BUCKET"
echo "table:  $TABLE"
echo "region: $REGION"
echo

run_case "valid image (800x800 png)"          "$DIR/valid.png"     png active
run_case "oversized file (6MB)"               "$DIR/oversized.png" png rejected
run_case "renamed .exe (PE header, .png ext)" "$DIR/fake.png"      png rejected
run_case "oversized dimensions (4200x4200 png)" "$DIR/toobig.png"  png rejected

rm -rf "$DIR"

echo
echo "---"
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]

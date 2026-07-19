#!/usr/bin/env bash
# Integration test for the S3 upload-validation lambda (S3Handler):
#   invalid extension -> deleted by lambda
#   oversized file    -> deleted by lambda
#   valid image       -> stays
#
# Usage: ./scripts/test-s3-handler.sh [stack-name]   (default: MemeDayDev)
# Bucket and region are read from the stack's CloudFormation outputs.
# Run with creds loaded (dotenv-cli lives in infra/):
#   cd infra && npx dotenv -e ../.env -- ../scripts/test-s3-handler.sh
set -uo pipefail

STACK="${1:-MemeDayDev}"

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
HANDLER_ARN="$(get_output S3HandlerArn)"
if [ -z "$BUCKET" ] || [ "$BUCKET" = "None" ] || [ -z "$HANDLER_ARN" ] || [ "$HANDLER_ARN" = "None" ]; then
  echo "Stack '$STACK' has no BucketName/S3HandlerArn outputs — no S3 handler deployed there. Nothing to test."
  exit 1
fi

DIR="$(mktemp -d)"
PREFIX="s3handler-test-$(date +%s)"
PASS=0
FAIL=0

# --- fixtures ---
echo "not an image" > "$DIR/bad.txt"
printf '\x89PNG\r\n\x1a\n' > "$DIR/ok.png"
head -c 100 /dev/urandom >> "$DIR/ok.png"
head -c $((11 * 1024 * 1024)) /dev/zero > "$DIR/big.png"

upload() {
  aws s3 cp "$1" "s3://$BUCKET/$2" --only-show-errors
}

exists() {
  aws s3api head-object --bucket "$BUCKET" --key "$1" >/dev/null 2>&1
}

# wait until object gone (deleted) or timeout; return 0 if gone
wait_gone() {
  local key="$1"
  for _ in $(seq 1 15); do
    exists "$key" || return 0
    sleep 2
  done
  return 1
}

check() { # $1=desc $2=expected(gone|stays) $3=key
  local desc="$1" expected="$2" key="$3"
  if [ "$expected" = "gone" ]; then
    if wait_gone "$key"; then
      echo "PASS: $desc -> deleted as expected"; PASS=$((PASS+1))
    else
      echo "FAIL: $desc -> still in bucket after 30s"; FAIL=$((FAIL+1))
    fi
  else
    sleep 15 # give the lambda time to (wrongly) delete
    if exists "$key"; then
      echo "PASS: $desc -> kept as expected"; PASS=$((PASS+1))
    else
      echo "FAIL: $desc -> was deleted, should stay"; FAIL=$((FAIL+1))
    fi
  fi
}

echo "stack:  $STACK"
echo "bucket: $BUCKET"
echo "region: $REGION"
echo "uploading fixtures..."
upload "$DIR/bad.txt" "$PREFIX/bad.txt"
upload "$DIR/big.png" "$PREFIX/big.png"
upload "$DIR/ok.png"  "$PREFIX/ok.png"

check "invalid extension (.txt)"  gone  "$PREFIX/bad.txt"
check "oversized file (11MB png)" gone  "$PREFIX/big.png"
check "valid image (small .png)"  stays "$PREFIX/ok.png"

# cleanup the valid object; invalid ones are already gone if the lambda works
aws s3 rm "s3://$BUCKET/$PREFIX/ok.png" --only-show-errors
rm -rf "$DIR"

echo "---"
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]

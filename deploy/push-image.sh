#!/usr/bin/env bash
# Build the Docker image and push it to Amazon ECR.
# Usage: AWS_REGION=us-east-1 ./deploy/push-image.sh [repo-name]
set -euo pipefail
REPO=${1:-timeclock}
REGION=${AWS_REGION:-us-east-1}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO" --region "$REGION" >/dev/null
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
docker build --platform linux/amd64 -t "$REPO:latest" "$(dirname "$0")/.."
docker tag "$REPO:latest" "$REGISTRY/$REPO:latest"
docker push "$REGISTRY/$REPO:latest"
echo "Pushed $REGISTRY/$REPO:latest"

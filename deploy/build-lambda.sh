#!/usr/bin/env bash
# Bundle the app into dist/lambda.zip for AWS Lambda (Node.js 22).
# The AWS SDK v3 is provided by the Lambda runtime, so it is left out of the bundle.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist/pkg
npx esbuild src/lambda.js --bundle --platform=node --target=node22 --minify \
  --external:@aws-sdk/* --external:dynalite --outfile=dist/pkg/index.js
cp -r public dist/pkg/public
(cd dist/pkg && zip -qr ../lambda.zip .)
ls -lh dist/lambda.zip

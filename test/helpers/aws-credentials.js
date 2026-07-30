const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// AWS SDK default credential chain reads ~/.aws/credentials automatically,
// so tests just need to detect whether creds are available for the skip guard.
function hasAwsCredentials() {
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) return true;
  return fs.existsSync(path.join(os.homedir(), ".aws", "credentials"));
}

module.exports = { hasAwsCredentials };

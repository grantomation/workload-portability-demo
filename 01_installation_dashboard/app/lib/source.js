// The setup entry point supplies these values to the dashboard Deployment.
function renderSource(content, env = process.env) {
  if (!content.includes('__SOURCE_REPO_')) return content;
  const url = env.SOURCE_REPO_URL || '';
  const revision = env.SOURCE_REPO_REVISION || '';
  let parsed;
  try { parsed = new URL(url); } catch (_) { throw new Error('SOURCE_REPO_URL must be configured by setup'); }
  if (!/^https:\/\/[A-Za-z0-9._~:/%+-]+$/.test(url) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('SOURCE_REPO_URL must be an HTTPS URL without credentials');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/+-]*$/.test(revision)) throw new Error('SOURCE_REPO_REVISION must be configured by setup');
  return content.replaceAll('__SOURCE_REPO_URL__', url).replaceAll('__SOURCE_REPO_REVISION__', revision);
}
module.exports = { renderSource };

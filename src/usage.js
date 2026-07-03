// Consulta o mesmo endpoint que alimenta o /usage do Claude Code.
// Não documentado oficialmente — pode mudar sem aviso.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA = 'oauth-2025-04-20';
// Sem um User-Agent no formato "claude-code/<versão>" o endpoint cai num
// bucket de rate limit agressivo e responde 429 (achado da comunidade).
const USER_AGENT = 'claude-code/2.0.14';

function headers(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'anthropic-beta': BETA,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
}

async function fetchUsage(accessToken) {
  const res = await fetch(USAGE_URL, { headers: headers(accessToken) });
  if (!res.ok) {
    const err = new Error(`usage HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  // Formato (pode variar):
  // {
  //   five_hour:        { utilization: 33.0, resets_at: "..." },
  //   seven_day:        { utilization: 13.0, resets_at: "..." },
  //   seven_day_sonnet: { ... } | null,
  //   seven_day_opus:   { ... } | null,
  //   extra_usage: { is_enabled, monthly_limit, used_credits, utilization }
  // }
  return res.json();
}

module.exports = { fetchUsage };

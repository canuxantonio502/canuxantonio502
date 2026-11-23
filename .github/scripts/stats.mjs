// Genera las tarjetas de estadísticas del perfil como SVG estáticos.
// Usa solo la API GraphQL de GitHub (sin servicios de terceros), así que
// las tarjetas viven en este repositorio y no se rompen si un servicio externo cae.
//
// Uso:
//   GITHUB_TOKEN=... GITHUB_USER=usuario node .github/scripts/stats.mjs dist
//   node .github/scripts/stats.mjs dist --mock   (datos de prueba, sin red)

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--')) || 'dist';
const mock = args.includes('--mock');
const login = process.env.GITHUB_USER || 'canuxantonio502';
const token = process.env.GITHUB_TOKEN;

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fmtDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const fmtNum = (n) => n.toLocaleString('es-GT');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Datos ---------- */

async function graphql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-stats' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub API respondió ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchData() {
  const base = await graphql(
    `query($login: String!) {
      user(login: $login) {
        createdAt
        followers { totalCount }
        pullRequests { totalCount }
        issues { totalCount }
        repositories(ownerAffiliations: OWNER, privacy: PUBLIC, first: 100) {
          totalCount
          nodes {
            isFork
            stargazerCount
            languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
              edges { size node { name color } }
            }
          }
        }
        contributionsCollection { totalCommitContributions }
      }
    }`,
    { login },
  );
  const user = base.user;
  if (!user) throw new Error(`No se encontró el usuario ${login}`);

  // El calendario solo admite rangos de un año: se consulta un alias por año.
  const start = new Date(user.createdAt);
  const now = new Date();
  const ranges = [];
  for (let y = start.getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    const from = y === start.getUTCFullYear() ? start : new Date(Date.UTC(y, 0, 1));
    const to = y === now.getUTCFullYear() ? now : new Date(Date.UTC(y, 11, 31, 23, 59, 59));
    ranges.push({ y, from: from.toISOString(), to: to.toISOString() });
  }
  const calQuery = `query($login: String!) { user(login: $login) { ${ranges
    .map((r) => `y${r.y}: contributionsCollection(from: "${r.from}", to: "${r.to}") { contributionCalendar { weeks { contributionDays { date contributionCount } } } }`)
    .join('\n')} } }`;
  const cal = await graphql(calQuery, { login });

  const days = new Map();
  for (const r of ranges) {
    for (const w of cal.user[`y${r.y}`].contributionCalendar.weeks) {
      for (const d of w.contributionDays) days.set(d.date, d.contributionCount);
    }
  }

  const own = user.repositories.nodes.filter((r) => !r.isFork);
  const langs = new Map();
  for (const repo of own) {
    for (const e of repo.languages.edges) {
      const cur = langs.get(e.node.name) || { size: 0, color: e.node.color || '#94a3b8' };
      cur.size += e.size;
      langs.set(e.node.name, cur);
    }
  }

  return {
    createdAt: user.createdAt.slice(0, 10),
    days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)),
    commitsYear: user.contributionsCollection.totalCommitContributions,
    prs: user.pullRequests.totalCount,
    issues: user.issues.totalCount,
    repos: user.repositories.totalCount,
    stars: own.reduce((s, r) => s + r.stargazerCount, 0),
    followers: user.followers.totalCount,
    languages: [...langs.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.size - a.size),
  };
}

function mockData() {
  const days = [];
  const d = new Date(Date.UTC(2025, 2, 1));
  const today = new Date();
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  while (d <= today) {
    days.push([d.toISOString().slice(0, 10), rnd() < 0.3 ? 0 : Math.floor(rnd() * 12)]);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return {
    createdAt: '2025-03-01', days, commitsYear: 642, prs: 38, issues: 12, repos: 25, stars: 9, followers: 14,
    languages: [
      { name: 'JavaScript', size: 520000, color: '#f1e05a' }, { name: 'HTML', size: 180000, color: '#e34c26' },
      { name: 'CSS', size: 150000, color: '#663399' }, { name: 'TypeScript', size: 60000, color: '#3178c6' },
      { name: 'Shell', size: 20000, color: '#89e051' }, { name: 'Java', size: 12000, color: '#b07219' },
    ],
  };
}

/* ---------- Cálculos ---------- */

function streaks(days) {
  const total = days.reduce((s, [, c]) => s + c, 0);
  let longest = { len: 0, start: null, end: null };
  let run = { len: 0, start: null, end: null };
  for (const [date, c] of days) {
    if (c > 0) {
      run = run.len ? { len: run.len + 1, start: run.start, end: date } : { len: 1, start: date, end: date };
      if (run.len > longest.len) longest = { ...run };
    } else {
      run = { len: 0, start: null, end: null };
    }
  }
  // La racha actual no se corta si hoy todavía no hay contribuciones.
  let i = days.length - 1;
  if (i >= 0 && days[i][1] === 0) i--;
  let current = { len: 0, start: null, end: null };
  if (i >= 0 && days[i][1] > 0) {
    let j = i;
    while (j > 0 && days[j - 1][1] > 0) j--;
    current = { len: i - j + 1, start: days[j][0], end: days[i][0] };
  }
  const last365 = days.slice(-365).reduce((s, [, c]) => s + c, 0);
  return { total, last365, longest, current, first: days[0]?.[0] };
}

/* ---------- Dibujo ---------- */

const FONT = "'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif";

function frame(w, h, title, body, updated) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1220"/><stop offset="1" stop-color="#0a1f1c"/></linearGradient>
    <linearGradient id="ac" x1="0" x2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#4ade80"/></linearGradient>
  </defs>
  <rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="14" fill="url(#bg)" stroke="#ffffff" stroke-opacity="0.12"/>
  <g font-family="${FONT}">
    <text x="28" y="40" font-size="17" font-weight="700" fill="#f1f5f9">${esc(title)}</text>
    <rect x="28" y="50" width="42" height="3" rx="1.5" fill="url(#ac)"/>
    ${body}
    <text x="${w - 24}" y="${h - 16}" text-anchor="end" font-size="11" fill="#64748b">Actualizado: ${esc(updated)}</text>
  </g>
</svg>
`;
}

const ICONS = {
  contrib: 'M1 2.5A2.5 2.5 0 0 1 3.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 1 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 3.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z',
  commit: 'M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z',
  pr: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  issue: 'M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z',
  repo: 'M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8Z',
  star: 'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z',
};

function statsCard(d, s, updated) {
  const rows = [
    ['contrib', 'Contribuciones (último año)', s.last365],
    ['commit', 'Commits (último año)', d.commitsYear],
    ['pr', 'Pull requests', d.prs],
    ['issue', 'Issues', d.issues],
    ['repo', 'Repositorios públicos', d.repos],
    ['star', 'Estrellas recibidas', d.stars],
  ];
  const body = rows
    .map(([icon, label, val], i) => {
      const y = 84 + i * 26;
      return `<g transform="translate(28,${y - 12})"><path d="${ICONS[icon]}" fill="#22d3ee" transform="scale(0.95)"/></g>
    <text x="54" y="${y + 1}" font-size="14" fill="#cbd5e1">${label}</text>
    <text x="452" y="${y + 1}" text-anchor="end" font-size="15" font-weight="700" fill="#f8fafc">${fmtNum(val)}</text>`;
    })
    .join('\n    ');
  return frame(480, 260, 'Estadísticas de GitHub', body, updated);
}

function languagesCard(d, updated) {
  const top = d.languages.slice(0, 6);
  const sum = top.reduce((s, l) => s + l.size, 0) || 1;
  let x = 28;
  const barW = 424;
  const segs = top
    .map((l) => {
      const w = (l.size / sum) * barW;
      const r = `<rect x="${x.toFixed(2)}" y="78" width="${w.toFixed(2)}" height="10" fill="${l.color}"/>`;
      x += w;
      return r;
    })
    .join('');
  const items = top
    .map((l, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const tx = 28 + col * 220, ty = 124 + row * 30;
      return `<circle cx="${tx + 6}" cy="${ty - 5}" r="6" fill="${l.color}"/>
    <text x="${tx + 20}" y="${ty}" font-size="14" fill="#cbd5e1">${esc(l.name)}</text>
    <text x="${tx + 200}" y="${ty}" text-anchor="end" font-size="14" font-weight="700" fill="#f8fafc">${((l.size / sum) * 100).toFixed(1)}%</text>`;
    })
    .join('\n    ');
  const body = `<clipPath id="bar"><rect x="28" y="78" width="${barW}" height="10" rx="5"/></clipPath>
    <g clip-path="url(#bar)"><rect x="28" y="78" width="${barW}" height="10" fill="#1e293b"/>${segs}</g>
    ${items}`;
  return frame(480, 260, 'Lenguajes más usados', body, updated);
}

function streakCard(s, updated) {
  const range = (r) => (r.len ? (r.start === r.end ? fmtDate(r.start) : `${fmtDate(r.start)} – ${fmtDate(r.end)}`) : 'Sin racha activa');
  const col = (cx, value, label, sub, highlight) => `
    <text x="${cx}" y="${highlight ? 132 : 130}" text-anchor="middle" font-size="${highlight ? 38 : 34}" font-weight="800" fill="${highlight ? 'url(#ac)' : '#f8fafc'}">${fmtNum(value)}</text>
    <text x="${cx}" y="198" text-anchor="middle" font-size="14" font-weight="600" fill="${highlight ? '#67e8f9' : '#e2e8f0'}">${label}</text>
    <text x="${cx}" y="218" text-anchor="middle" font-size="12" fill="#94a3b8">${esc(sub)}</text>`;
  const ring = `<circle cx="490" cy="116" r="54" fill="none" stroke="#1e293b" stroke-width="6"/>
    <circle cx="490" cy="116" r="54" fill="none" stroke="url(#ac)" stroke-width="6" stroke-linecap="round"
      stroke-dasharray="${(2 * Math.PI * 54).toFixed(1)}" stroke-dashoffset="0" transform="rotate(-90 490 116)"/>
    <path d="M490 46c6 9 14 13 14 24a14 14 0 0 1-28 0c0-5 2-8 5-11 0 5 3 7 5 7-2-8 1-14 4-20z" fill="#fb923c"/>`;
  const body = `<line x1="327" y1="80" x2="327" y2="190" stroke="#ffffff" stroke-opacity="0.1"/>
    <line x1="653" y1="80" x2="653" y2="190" stroke="#ffffff" stroke-opacity="0.1"/>
    ${ring}
    ${col(164, s.total, 'Contribuciones totales', `${fmtDate(s.first)} – hoy`)}
    ${col(490, s.current.len, 'Racha actual (días)', range(s.current), true)}
    ${col(816, s.longest.len, 'Racha más larga (días)', range(s.longest))}`;
  return frame(980, 260, 'Contribuciones y racha', body, updated);
}

/* ---------- Main ---------- */

const data = mock ? mockData() : await (async () => {
  if (!token) throw new Error('Falta GITHUB_TOKEN (o usa --mock).');
  return fetchData();
})();
const s = streaks(data.days);
const updated = fmtDate(new Date().toISOString().slice(0, 10));

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'stats.svg'), statsCard(data, s, updated));
await writeFile(join(outDir, 'languages.svg'), languagesCard(data, updated));
await writeFile(join(outDir, 'streak.svg'), streakCard(s, updated));
console.log(`Tarjetas generadas en ${outDir}: total ${s.total}, racha actual ${s.current.len}, más larga ${s.longest.len}`);

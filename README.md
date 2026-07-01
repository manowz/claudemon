# Claudémon 🔴

Widget de desktop (Electron) que mostra o consumo da sua assinatura do Claude com um Pokémon 8-bit aleatório dançando na tela. Sempre visível, arrastável, com ícone na bandeja.

## O que ele mostra

| Bloco | Origem |
|---|---|
| **Sessão 5h** | janela de uso atual + contagem regressiva do reset |
| **Semana** | limite semanal (7 dias) + dia/hora do reset |
| **Sonnet/Opus 7d** | sub-limites semanais por modelo (aparecem conforme o plano) |
| **Extra · Mês** | créditos de *extra usage* usados no mês vs. limite mensal (se ativado) |

> O Claude não tem limite "diário" — os limites reais da assinatura são a **sessão de 5 horas** e a **janela semanal**; o único valor mensal é o *extra usage* pago à parte. O widget mostra exatamente essas janelas.

Os dados vêm de `GET https://api.anthropic.com/api/oauth/usage` — o mesmo endpoint que alimenta o `/usage` do Claude Code.

## Rodando

Requisitos: Node 18+.

```bash
npm install
npm start
```

## Login (2 opções)

1. **Usar login do Claude Code** — se o Claude Code já está logado na máquina (`~/.claude/.credentials.json`), o botão aparece e conecta em 1 clique. Quando esse token expira, o widget apenas **relê o arquivo** (nunca usa o refresh token do Claude Code, para não derrubar a sessão dele). Se ficar expirado, abra o Claude Code uma vez.
2. **Conectar com Claude** — fluxo OAuth+PKCE: abre o navegador em `claude.ai/oauth/authorize`, você autoriza, a página de callback mostra um código no formato `codigo#state` — cole no widget. O refresh é automático depois disso.

Os tokens ficam **somente na sua máquina**, criptografados via `safeStorage` (DPAPI no Windows), em `%APPDATA%/claudemon/config.json`.

## Pokémon

Sprites animados da **Geração V (Black/White)** via PokeAPI — pixel art com animação de idle (a "dança"). A cada abertura do widget sorteia um dos 649 (nunca repete o anterior imediato). O botão ▣ na barra sorteia outro; clicar no bicho faz ele pular. Pokémon © Nintendo/Game Freak — uso pessoal.

## Bandeja (tray)

Atualizar agora · Trocar Pokémon · Sempre visível · Iniciar com o sistema · Sair.

## Avisos importantes

- Os endpoints `api/oauth/usage`, `api/oauth/profile` e o fluxo OAuth do Claude Code **não são API pública documentada**. A Anthropic pode mudá-los ou restringi-los a qualquer momento — se quebrar, provavelmente foi isso.
- O widget usa o token **apenas para ler o consumo** (nunca para inferência). Uso de OAuth de assinatura para inferência em apps de terceiros é justamente o que a Anthropic vem bloqueando.
- O `User-Agent` das chamadas de usage é `claude-code/<versão>` porque, sem esse formato, o endpoint responde `429` (bucket de rate limit agressivo). Constante em `src/usage.js`.
- Polling padrão: a cada 2 min, com backoff até 15 min em caso de 429 (`POLL_MS` em `main.js`).
- Se o login OAuth retornar `403` no usage, edite `SCOPES` em `src/oauth.js` (adicione `user:sessions:claude_code`) e refaça o login.

## Empacotar (opcional)

```bash
npm i -D electron-builder
npx electron-builder --win portable
```

Adicione ao `package.json` se quiser customizar:

```json
"build": { "appId": "br.manowz.claudemon", "win": { "icon": "assets/icon.png" } }
```

## Estrutura

```
claudemon/
├── main.js            # janela, tray, IPC, polling, ciclo dos tokens
├── preload.js         # ponte segura p/ o renderer
├── src/
│   ├── config.js      # persistência + criptografia dos tokens
│   ├── oauth.js       # PKCE, troca/refresh, import do Claude Code
│   └── usage.js       # GET usage/profile
├── renderer/          # UI (HTML/CSS/JS puro)
└── assets/            # ícones (pokébola)
```
